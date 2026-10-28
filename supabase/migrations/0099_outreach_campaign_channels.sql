-- Explicit business campaign assignments for independent outbound activation.
-- Existing assignments remain email; no campaigns or activation rows are seeded.
alter table public.outreach_campaigns add column channel text not null default 'email'
  check(channel in ('email','linkedin'));
alter table public.outreach_campaigns add constraint outreach_linkedin_campaign_identity
  check(channel<>'linkedin' or case when provider_campaign_id ~ '^[1-9][0-9]{0,15}$'
    then provider_campaign_id::numeric<=9007199254740991 else false end);


create or replace function outreach_private.guard_assignment() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.id is distinct from old.id or new.client_id is distinct from old.client_id or new.provider_campaign_id is distinct from old.provider_campaign_id or new.channel is distinct from old.channel then
    raise exception 'Unassign the campaign before changing ownership';
  end if;
  if old.messages_purged_at is not null and new.messages_purged_at is distinct from old.messages_purged_at then
    raise exception 'Message retention cannot be reversed';
  end if;
  return new;
end;
$$;

create or replace function outreach_private.initialize_sync_state() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.channel='email' then
    insert into public.outreach_sync_state(campaign_id,client_id) values(new.id,new.client_id);
  end if;
  return new;
end;
$$;

create or replace function outreach_private.read_campaigns() returns table(id uuid,client_id uuid,name text,status text,schedule jsonb,totals jsonb,synced_at timestamptz,completed_at timestamptz,created_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select c.id,c.client_id,c.name,c.status,outreach_private.schedule(c.schedule),outreach_private.metrics(c.totals,array['leads','contacted','sent','unique_opened','unique_replies','unique_auto_replies','bounced','unsubscribed','completed','opportunities','positive_replies','unique_clicks']),c.synced_at,c.completed_at,c.created_at from public.outreach_campaigns c where c.channel='email' and outreach_private.can_read(c.client_id);
$$;

create or replace function outreach_private.read_campaign_steps() returns table(campaign_id uuid,client_id uuid,step integer,variant integer,subject text,body_text text,delay_days numeric,stats jsonb)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select c.campaign_id,c.client_id,c.step,c.variant,c.subject,c.body_text,c.delay_days,outreach_private.metrics(c.stats,array['sent','contacted','unique_opened','unique_replies','unique_auto_replies','unique_clicks','opportunities']) from public.outreach_campaign_steps c where exists(select 1 from public.outreach_campaigns assignment where assignment.id=c.campaign_id and assignment.client_id=c.client_id and assignment.channel='email') and outreach_private.can_read(c.client_id);
$$;

create or replace function outreach_private.read_campaign_daily() returns table(campaign_id uuid,client_id uuid,day date,sent bigint,contacted bigint,new_contacted bigint,unique_opened bigint,unique_replies bigint,auto_replies bigint,unique_clicks bigint,opportunities bigint)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select c.campaign_id,c.client_id,c.day,c.sent,c.contacted,c.new_contacted,c.unique_opened,c.unique_replies,c.auto_replies,c.unique_clicks,c.opportunities from public.outreach_campaign_daily c where exists(select 1 from public.outreach_campaigns assignment where assignment.id=c.campaign_id and assignment.client_id=c.client_id and assignment.channel='email') and outreach_private.can_read(c.client_id);
$$;

create or replace function outreach_private.read_leads() returns table(id uuid,campaign_id uuid,client_id uuid,email text,first_name text,last_name text,company text,status text,last_step integer,reply_count integer,interest text,last_activity_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select c.id,c.campaign_id,c.client_id,c.email,c.first_name,c.last_name,c.company,c.status,c.last_step,c.reply_count,c.interest,c.last_activity_at from public.outreach_leads c where exists(select 1 from public.outreach_campaigns assignment where assignment.id=c.campaign_id and assignment.client_id=c.client_id and assignment.channel='email') and outreach_private.can_read(c.client_id);
$$;

create or replace function outreach_private.read_messages() returns table(id uuid,campaign_id uuid,client_id uuid,thread_key uuid,direction text,lead_email text,from_email text,to_email text,subject text,body_text text,sent_at timestamptz,interest text,is_auto_reply boolean,client_read_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select c.id,c.campaign_id,c.client_id,c.thread_key,c.direction,c.lead_email,c.from_email,c.to_email,c.subject,c.body_text,c.sent_at,c.interest,c.is_auto_reply,c.client_read_at from public.outreach_messages c where exists(select 1 from public.outreach_campaigns assignment where assignment.id=c.campaign_id and assignment.client_id=c.client_id and assignment.channel='email') and outreach_private.can_read(c.client_id);
$$;

-- An assignment change resets pagination and fences in-flight cached scopes.
create function outreach_private.reset_linkedin_campaign_scope() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare tenant_id uuid;
begin
  if tg_op='DELETE' then
    if old.channel<>'linkedin' then return old; end if;
    tenant_id:=old.client_id;
  else
    if new.channel<>'linkedin' then return new; end if;
    if tg_op='UPDATE' and new.messages_purged_at is not distinct from old.messages_purged_at then return new; end if;
    tenant_id:=new.client_id;
  end if;
  -- Campaign -> client -> sender is the same lock order as retention/replies.
  -- During tenant cascade deletion, do not rewrite senders awaiting deletion.
  perform 1 from public.clients where id=tenant_id for no key update;
  if not found then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  update public.outreach_reply_senders set sync_cursor=null,synced_at=null,version=version+1
    where client_id=tenant_id and channel='linkedin';
  if tg_op='DELETE' then return old; end if;
  return new;
end; $$;
revoke all on function outreach_private.reset_linkedin_campaign_scope() from public,anon,authenticated,service_role;
-- Acquire the client fence before FK cascades can lock conversations/messages.
create trigger outreach_linkedin_campaign_scope before insert or delete or update of messages_purged_at
  on public.outreach_campaigns for each row execute function outreach_private.reset_linkedin_campaign_scope();

create function outreach_private.conversation_campaign_allowed(p_row public.outreach_conversations) returns boolean
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select p_row.channel='email' or exists(select 1 from public.outreach_campaigns c
    where c.id=p_row.campaign_id and c.client_id=p_row.client_id and c.channel='linkedin' and c.messages_purged_at is null);
$$;
revoke all on function outreach_private.conversation_campaign_allowed(public.outreach_conversations) from public,anon,authenticated,service_role;

-- Service-side imports must satisfy the same tenant/channel boundary as reads.
create function outreach_private.guard_conversation_campaign() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if new.channel='linkedin' and new.campaign_id is null then
    raise exception using errcode='42501',message='Conversation campaign unavailable';
  end if;
  if new.campaign_id is not null then
    perform 1 from public.outreach_campaigns c where c.id=new.campaign_id and c.client_id=new.client_id
      and c.channel=new.channel and c.messages_purged_at is null for key share;
    if not found then raise exception using errcode='42501',message='Conversation campaign unavailable'; end if;
  end if;
  if tg_op='UPDATE' and new.campaign_id is distinct from old.campaign_id then
    raise exception using errcode='42501',message='Conversation campaign identity cannot change';
  end if;
  return new;
end; $$;
revoke all on function outreach_private.guard_conversation_campaign() from public,anon,authenticated,service_role;
create trigger outreach_conversation_campaign_scope before insert or update of campaign_id,client_id,channel
  on public.outreach_conversations for each row execute function outreach_private.guard_conversation_campaign();


create or replace function public.list_outreach_conversations(p_client_id uuid,p_channel text default 'all',p_limit integer default 51,p_before_at timestamptz default null,p_before_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare result jsonb;
begin
  if not outreach_private.can_read(p_client_id) then raise exception using errcode='42501',message='Conversation access denied'; end if;
  if p_channel is null or p_channel not in ('all','email','linkedin') or p_limit is null or p_limit not between 1 and 100 or (p_before_at is null)<>(p_before_id is null) then raise exception using errcode='22023',message='Invalid conversation request'; end if;
  select coalesce(jsonb_agg(outreach_private.conversation_summary(q) order by q.latest_at desc,q.id desc),'[]'::jsonb) into result
    from (select c.* from public.outreach_conversations c where c.client_id=p_client_id and outreach_private.conversation_campaign_allowed(c) and (p_channel='all' or c.channel=p_channel)
      and (p_before_at is null or (c.latest_at,c.id)<(p_before_at,p_before_id)) order by c.latest_at desc,c.id desc limit p_limit) q;
  return result;
end; $$;

create or replace function public.read_outreach_conversation(p_client_id uuid,p_conversation_id uuid,p_limit integer default 100,p_before_at timestamptz default null,p_before_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_conversations%rowtype; messages jsonb; commands jsonb; message_count integer;
begin
  if not outreach_private.can_read(p_client_id) then raise exception using errcode='42501',message='Conversation access denied'; end if;
  if p_limit is null or p_limit not between 1 and 100 or (p_before_at is null)<>(p_before_id is null) then raise exception using errcode='22023',message='Invalid conversation request'; end if;
  select * into c from public.outreach_conversations where id=p_conversation_id and client_id=p_client_id;
  if not found or not outreach_private.conversation_campaign_allowed(c) then raise exception using errcode='42501',message='Conversation access denied'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'direction',m.direction,'bodyText',m.body_text,'sentAt',m.sent_at,'senderLabel',m.sender_label) order by m.sent_at,m.id),'[]'::jsonb)
    into messages from (select * from public.outreach_conversation_messages where conversation_id=c.id and (p_before_at is null or (sent_at,id)<(p_before_at,p_before_id)) order by sent_at desc,id desc limit p_limit) m;
  select count(*) into message_count from (select id from public.outreach_conversation_messages where conversation_id=c.id and (p_before_at is null or (sent_at,id)<(p_before_at,p_before_id)) limit p_limit+1) m;
  select coalesce(jsonb_agg(outreach_private.reply_command(q) order by q.created_at,q.id),'[]'::jsonb) into commands
    from (select * from public.outreach_reply_commands where conversation_id=c.id order by created_at desc,id desc limit 50) q;
  return outreach_private.conversation_summary(c)||jsonb_build_object('messages',messages,'commands',commands,'messagesTruncated',message_count>p_limit);
end; $$;

create or replace function public.change_outreach_conversation_owner(p_client_id uuid,p_conversation_id uuid,p_expected_version bigint,p_owner text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare stamp text; c public.outreach_conversations%rowtype; owner_id uuid;
begin
  stamp:=outreach_private.lock_reply_authority(p_client_id,auth.uid());
  select * into c from public.outreach_conversations where id=p_conversation_id and client_id=p_client_id for update;
  if not found or not outreach_private.conversation_campaign_allowed(c) then raise exception using errcode='42501',message='Conversation access denied'; end if;
  if p_expected_version is distinct from c.version or p_owner is null or p_owner not in ('me','covora') then raise exception using errcode='22023',message='Conversation changed. Refresh before continuing.'; end if;
  if p_owner='covora' and c.owner_user_id is distinct from auth.uid() and stamp not like 'agency_owner:%' then raise exception using errcode='42501',message='Only the current owner can return this conversation'; end if;
  owner_id:=case when p_owner='me' then auth.uid() else null end;
  perform outreach_private.expire_replies(p_client_id);
  if owner_id is distinct from c.owner_user_id then
    update public.outreach_reply_commands set status='cancelled',error_code='owner_changed',updated_at=clock_timestamp() where conversation_id=c.id and status in ('queued','preparing');
    update public.outreach_conversations set owner_user_id=owner_id,updated_at=clock_timestamp() where id=c.id;
    insert into public.outreach_access_audit(client_id,actor_user_id,subject_id,event_type,details) values(p_client_id,auth.uid(),c.id,'conversation_owner_changed',jsonb_build_object('owner_user_id',owner_id));
  end if;
  return public.read_outreach_conversation(p_client_id,p_conversation_id);
end; $$;

create or replace function public.read_outreach_reply(p_client_id uuid,p_conversation_id uuid,p_command_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare command public.outreach_reply_commands%rowtype;
begin
  if not outreach_private.can_read(p_client_id) or not exists(select 1 from public.outreach_conversations c where c.id=p_conversation_id and c.client_id=p_client_id and outreach_private.conversation_campaign_allowed(c)) then raise exception using errcode='42501',message='Conversation access denied'; end if;
  select * into command from public.outreach_reply_commands where id=p_command_id and client_id=p_client_id and conversation_id=p_conversation_id;
  if not found then raise exception using errcode='42501',message='Conversation access denied'; end if;
  return outreach_private.reply_command(command);
end; $$;

create or replace function public.mark_outreach_conversation_read(p_client_id uuid,p_conversation_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  perform outreach_private.lock_team_workspace(p_client_id);
  if not outreach_private.can_read(p_client_id) or not exists(select 1 from public.outreach_conversations c where id=p_conversation_id and client_id=p_client_id and outreach_private.conversation_campaign_allowed(c)) then raise exception using errcode='42501',message='Conversation access denied'; end if;
  insert into public.outreach_conversation_reads(client_id,conversation_id,user_id) values(p_client_id,p_conversation_id,auth.uid())
    on conflict(conversation_id,user_id) do update set read_at=clock_timestamp();
end; $$;

create or replace function public.enqueue_outreach_reply(p_client_id uuid,p_conversation_id uuid,p_command_id uuid,p_expected_version bigint,p_latest_message_id uuid,p_body text,p_takeover boolean default false) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare stamp text; c public.outreach_conversations%rowtype; command public.outreach_reply_commands%rowtype; sender public.outreach_reply_senders%rowtype; workspace public.outreach_reply_workspaces%rowtype; body text;
begin
  if not outreach_private.can_read(p_client_id) then raise exception using errcode='42501',message='Reply access denied'; end if;
  -- A command's latest-message FK takes a message key-share lock. Retention
  -- locks campaign before deleting that message, so reserve campaign first.
  perform 1 from public.outreach_campaigns campaign join public.outreach_conversations thread on thread.campaign_id=campaign.id
    where thread.id=p_conversation_id and thread.client_id=p_client_id for key share of campaign;
  stamp:=outreach_private.lock_reply_authority(p_client_id,auth.uid());
  body:=btrim(p_body,E' \t\n\r\f\013'||U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
  if p_command_id is null or body is null or length(body) not between 1 and 4000 or p_takeover is null then raise exception using errcode='22023',message='Invalid reply'; end if;
  select * into c from public.outreach_conversations where id=p_conversation_id and client_id=p_client_id for update;
  if not found or not outreach_private.conversation_campaign_allowed(c) then raise exception using errcode='42501',message='Conversation access denied'; end if;
  select * into command from public.outreach_reply_commands where id=p_command_id;
  if found then
    if command.client_id<>p_client_id or command.conversation_id<>p_conversation_id or command.actor_user_id<>auth.uid() or command.body_text<>body or command.latest_message_id is distinct from p_latest_message_id then raise exception using errcode='22023',message='Reply request does not match its original content'; end if;
    return outreach_private.reply_command(command);
  end if;
  perform outreach_private.expire_replies(p_client_id);
  if p_expected_version is distinct from c.version or p_latest_message_id is null or c.latest_message_id is distinct from p_latest_message_id then raise exception using errcode='22023',message='Conversation changed. Refresh before replying.'; end if;
  if c.owner_user_id is distinct from auth.uid() and not p_takeover then raise exception using errcode='42501',message='Take ownership before replying'; end if;
  select * into sender from public.outreach_reply_senders where id=c.sender_id for share;
  select * into workspace from public.outreach_reply_workspaces where id=sender.workspace_id for share;
  if sender.id is null or not sender.enabled or not coalesce(workspace.enabled,false) or c.suppressed then raise exception using errcode='42501',message='Replies are unavailable for this account'; end if;
  if c.channel='email' and not exists(select 1 from public.outreach_conversation_messages where conversation_id=c.id and direction='received') then raise exception using errcode='22023',message='An incoming message is required'; end if;
  if c.owner_user_id is distinct from auth.uid() then
    update public.outreach_reply_commands set status='cancelled',error_code='owner_changed',updated_at=clock_timestamp() where conversation_id=c.id and status in ('queued','preparing');
  end if;
  if exists(select 1 from public.outreach_reply_commands where (conversation_id=c.id and status in ('queued','preparing','sending','unknown')) or (sender_id=sender.id and status in ('queued','preparing','sending','unknown'))) then raise exception using errcode='22023',message='Wait for the current reply outcome before sending again'; end if;
  if c.owner_user_id is distinct from auth.uid() then
    insert into public.outreach_access_audit(client_id,actor_user_id,subject_id,event_type,details) values(p_client_id,auth.uid(),c.id,'conversation_owner_changed',jsonb_build_object('owner_user_id',auth.uid()));
  end if;
  update public.outreach_conversations set owner_user_id=auth.uid(),updated_at=clock_timestamp() where id=c.id returning * into c;
  insert into public.outreach_reply_commands(id,client_id,conversation_id,channel,sender_id,actor_user_id,authority_stamp,conversation_version,latest_message_id,workspace_version,sender_version,body_text)
    values(p_command_id,p_client_id,c.id,c.channel,sender.id,auth.uid(),stamp,c.version,p_latest_message_id,workspace.version,sender.version,body) returning * into command;
  insert into public.outreach_access_audit(client_id,actor_user_id,subject_id,event_type) values(p_client_id,auth.uid(),command.id,'reply_requested');
  return outreach_private.reply_command(command);
exception when unique_violation then raise exception using errcode='22023',message='Reply request is unavailable';
end; $$;

create or replace function outreach_private.reply_is_current(p_command public.outreach_reply_commands) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare stamp text; c public.outreach_conversations%rowtype; sender public.outreach_reply_senders%rowtype; workspace public.outreach_reply_workspaces%rowtype;
begin
  begin stamp:=outreach_private.lock_reply_authority(p_command.client_id,p_command.actor_user_id);
  exception when insufficient_privilege then return false; end;
  select * into c from public.outreach_conversations where id=p_command.conversation_id for update;
  select * into sender from public.outreach_reply_senders where id=p_command.sender_id for share;
  select * into workspace from public.outreach_reply_workspaces where id=sender.workspace_id for share;
  return coalesce(stamp=p_command.authority_stamp and c.owner_user_id=p_command.actor_user_id
    and c.version=p_command.conversation_version and c.latest_message_id=p_command.latest_message_id
    and c.sender_id=sender.id and outreach_private.conversation_campaign_allowed(c) and not c.suppressed and sender.enabled and workspace.enabled
    and sender.version=p_command.sender_version and workspace.version=p_command.workspace_version,false);
end; $$;

-- Remove the old unscoped import entry point; old deployments fail closed.
drop function public.sync_outreach_linkedin_conversation(uuid,text,text,text,text,jsonb);
create function public.sync_outreach_linkedin_conversation(p_sender_id uuid,p_campaign_id uuid,p_remote_campaign_id text,p_sender_version bigint,p_workspace_version bigint,p_remote_conversation_id text,p_contact_name text,p_contact_address text,p_subject text,p_messages jsonb) returns uuid
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sender public.outreach_reply_senders%rowtype; workspace public.outreach_reply_workspaces%rowtype; item jsonb; thread_id uuid; item_time timestamptz;
begin
  -- Preserve campaign-before-client lock order used by retention and enqueue.
  perform 1 from public.outreach_campaigns where id=p_campaign_id and channel='linkedin'
    and provider_campaign_id=p_remote_campaign_id and messages_purged_at is null for key share;
  if not found then raise exception using errcode='42501',message='Conversation campaign unavailable'; end if;
  select * into sender from public.outreach_reply_senders where id=p_sender_id and channel='linkedin';
  if not found then raise exception using errcode='42501',message='Conversation binding unavailable'; end if;
  perform outreach_private.lock_team_workspace(sender.client_id);
  select * into sender from public.outreach_reply_senders where id=p_sender_id for share;
  select * into workspace from public.outreach_reply_workspaces where id=sender.workspace_id for share;
  if sender.version is distinct from p_sender_version or workspace.version is distinct from p_workspace_version
    or not exists(select 1 from public.outreach_campaigns c where c.id=p_campaign_id and c.client_id=sender.client_id
      and c.channel='linkedin' and c.provider_campaign_id=p_remote_campaign_id and c.messages_purged_at is null) then
    raise exception using errcode='42501',message='Conversation campaign unavailable';
  end if;
  if not coalesce(workspace.sync_enabled,false) then raise exception using errcode='42501',message='Conversation syncing is disabled'; end if;
  if p_remote_conversation_id is null or length(p_remote_conversation_id) not between 1 and 1000 or
    p_contact_name is null or length(p_contact_name)>500 or p_contact_address is null or length(p_contact_address) not between 1 and 1000 or p_subject is null or length(p_subject)>1000 or
    jsonb_typeof(p_messages) is distinct from 'array' then raise exception using errcode='22023',message='Invalid conversation import'; end if;
  if jsonb_array_length(p_messages)>500 then raise exception using errcode='22023',message='Conversation import is too large'; end if;
  if exists(select 1 from public.outreach_conversations c where c.sender_id=p_sender_id and c.remote_conversation_id=p_remote_conversation_id and c.channel='linkedin' and c.campaign_id is distinct from p_campaign_id) then
    raise exception using errcode='42501',message='Conversation campaign identity cannot change';
  end if;
  insert into public.outreach_conversations(client_id,channel,sender_id,campaign_id,remote_conversation_id,sender_address,contact_name,contact_address,subject,synced_at)
    values(sender.client_id,'linkedin',sender.id,p_campaign_id,p_remote_conversation_id,sender.sender_address,p_contact_name,p_contact_address,p_subject,clock_timestamp())
    on conflict(sender_id,remote_conversation_id) where channel='linkedin' do update set
      contact_name=excluded.contact_name,subject=excluded.subject,synced_at=excluded.synced_at,
      suppressed=outreach_conversations.suppressed or outreach_conversations.contact_address<>excluded.contact_address
    returning id into thread_id;
  for item in select value from jsonb_array_elements(p_messages) loop
    if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'fingerprint') is distinct from 'string' or length(item->>'fingerprint') not between 1 and 1000 or
      jsonb_typeof(item->'direction') is distinct from 'string' or item->>'direction' not in ('sent','received') or
      jsonb_typeof(item->'bodyText') is distinct from 'string' or length(item->>'bodyText')>100000 or
      jsonb_typeof(item->'sentAt') is distinct from 'string' or jsonb_typeof(item->'senderLabel') is distinct from 'string' or length(item->>'senderLabel')>1000 then
      raise exception using errcode='22023',message='Invalid conversation message';
    end if;
    begin item_time:=(item->>'sentAt')::timestamptz;
    exception when others then raise exception using errcode='22023',message='Invalid message time'; end;
    if not isfinite(item_time) then raise exception using errcode='22023',message='Invalid message time'; end if;
    insert into public.outreach_conversation_messages(client_id,conversation_id,remote_message_id,remote_fingerprint,direction,body_text,sent_at,sender_label)
      values(sender.client_id,thread_id,item->>'fingerprint',item->>'fingerprint',item->>'direction',item->>'bodyText',item_time,item->>'senderLabel')
      on conflict(conversation_id,remote_message_id) do update set body_text=excluded.body_text,sent_at=excluded.sent_at,sender_label=excluded.sender_label,direction=excluded.direction
      where (outreach_conversation_messages.body_text,outreach_conversation_messages.sent_at,outreach_conversation_messages.sender_label,outreach_conversation_messages.direction)
        is distinct from (excluded.body_text,excluded.sent_at,excluded.sender_label,excluded.direction);
  end loop;
  return thread_id;
end; $$;
revoke all on function public.sync_outreach_linkedin_conversation(uuid,uuid,text,bigint,bigint,text,text,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.sync_outreach_linkedin_conversation(uuid,uuid,text,bigint,bigint,text,text,text,text,jsonb) to service_role;
notify pgrst,'reload schema';
