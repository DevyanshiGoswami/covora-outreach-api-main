-- Extracted for the independent outbound platform; see docs/schema-extraction.md.
-- Existing-thread replies only. Bindings are private and disabled until explicitly
-- configured; account verification and results access never grant sending rights.
create table public.outreach_reply_workspaces (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  channel text not null check(channel in ('email','linkedin')),
  remote_workspace_id text not null check(length(remote_workspace_id) between 1 and 200),
  credential_ref text not null unique check(credential_ref ~ '^OUTREACH_(INSTANTLY|HEYREACH)_[A-Z0-9_]{1,100}$'),
  enabled boolean not null default false,
  sync_enabled boolean not null default false,
  version bigint not null default 1,
  unique(client_id,channel), unique(channel,remote_workspace_id), unique(id,client_id,channel),
  check((channel='email' and credential_ref like 'OUTREACH_INSTANTLY_%') or (channel='linkedin' and credential_ref like 'OUTREACH_HEYREACH_%'))
);
create table public.outreach_reply_senders (
  id uuid primary key default gen_random_uuid(), client_id uuid not null, channel text not null,
  workspace_id uuid not null,
  remote_sender_id text not null check(length(remote_sender_id) between 1 and 254),
  sender_address text not null check(length(sender_address) between 1 and 500),
  sender_label text not null check(length(sender_label) between 1 and 200),
  enabled boolean not null default false, version bigint not null default 1,
  sync_cursor text, sync_started_at timestamptz, synced_at timestamptz,
  unique(channel,remote_sender_id), unique(id,client_id,channel),
  foreign key(workspace_id,client_id,channel) references public.outreach_reply_workspaces(id,client_id,channel) on delete cascade
);
create table public.outreach_conversations (
  id uuid primary key default gen_random_uuid(), client_id uuid not null references public.clients(id) on delete cascade,
  channel text not null check(channel in ('email','linkedin')), sender_id uuid,
  campaign_id uuid, source_thread_key uuid,
  remote_conversation_id text not null check(length(remote_conversation_id) between 1 and 1000),
  sender_address text not null default '', contact_name text not null default '', contact_address text not null default '', subject text not null default '',
  owner_user_id uuid, version bigint not null default 1,
  latest_message_id uuid, latest_at timestamptz not null default clock_timestamp(),
  status text not null default 'needs_reply' check(status in ('needs_reply','waiting','done')),
  suppressed boolean not null default false,
  synced_at timestamptz, created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  unique(id,client_id), unique(campaign_id,source_thread_key),
  foreign key(sender_id,client_id,channel) references public.outreach_reply_senders(id,client_id,channel),
  foreign key(campaign_id,client_id) references public.outreach_campaigns(id,client_id) on delete cascade
);
create unique index outreach_linkedin_conversation_unique on public.outreach_conversations(sender_id,remote_conversation_id) where channel='linkedin';
create index outreach_conversation_page on public.outreach_conversations(client_id,channel,latest_at desc,id desc);
create table public.outreach_conversation_messages (
  id uuid primary key default gen_random_uuid(), client_id uuid not null, conversation_id uuid not null,
  source_message_id uuid unique references public.outreach_messages(id) on delete cascade,
  remote_message_id text not null, remote_fingerprint text,
  direction text not null check(direction in ('sent','received')), body_text text not null, sent_at timestamptz not null,
  sender_label text not null default '', is_auto_reply boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  unique(conversation_id,remote_message_id), unique(id,conversation_id,client_id),
  foreign key(conversation_id,client_id) references public.outreach_conversations(id,client_id) on delete cascade
);
alter table public.outreach_conversations add constraint outreach_conversation_latest_message_fk foreign key(latest_message_id,id,client_id) references public.outreach_conversation_messages(id,conversation_id,client_id) deferrable initially deferred;
create index outreach_conversation_messages_page on public.outreach_conversation_messages(conversation_id,sent_at desc,id desc);
create table public.outreach_reply_commands (
  id uuid primary key, client_id uuid not null, conversation_id uuid not null, channel text not null,
  sender_id uuid not null, actor_user_id uuid not null, authority_stamp text not null,
  conversation_version bigint not null, latest_message_id uuid not null,
  workspace_version bigint not null, sender_version bigint not null,
  body_text text not null check(length(body_text) between 1 and 4000),
  status text not null default 'queued' check(status in ('queued','preparing','sending','sent','failed','unknown','cancelled')),
  claim_token uuid, expires_at timestamptz default (clock_timestamp()+interval '60 seconds'), remote_message_id text, error_code text,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  foreign key(conversation_id,client_id) references public.outreach_conversations(id,client_id) on delete cascade,
  foreign key(sender_id,client_id,channel) references public.outreach_reply_senders(id,client_id,channel),
  foreign key(latest_message_id,conversation_id,client_id) references public.outreach_conversation_messages(id,conversation_id,client_id) on delete cascade
);
create unique index outreach_reply_one_active_thread on public.outreach_reply_commands(conversation_id) where status in ('queued','preparing','sending','unknown');
create unique index outreach_reply_one_active_sender on public.outreach_reply_commands(sender_id) where status in ('queued','preparing','sending','unknown');
create index outreach_reply_command_history on public.outreach_reply_commands(conversation_id,created_at desc,id desc);
create table public.outreach_conversation_reads (
  client_id uuid not null, conversation_id uuid not null, user_id uuid not null,
  read_at timestamptz not null default clock_timestamp(), primary key(conversation_id,user_id),
  foreign key(conversation_id,client_id) references public.outreach_conversations(id,client_id) on delete cascade
);

alter table public.outreach_reply_workspaces enable row level security;
alter table public.outreach_reply_senders enable row level security;
alter table public.outreach_conversations enable row level security;
alter table public.outreach_conversation_messages enable row level security;
alter table public.outreach_reply_commands enable row level security;
alter table public.outreach_conversation_reads enable row level security;
create policy outreach_reply_workspaces_service on public.outreach_reply_workspaces for all to service_role using(true) with check(true);
create policy outreach_reply_senders_service on public.outreach_reply_senders for all to service_role using(true) with check(true);
create policy outreach_conversations_service on public.outreach_conversations for all to service_role using(true) with check(true);
create policy outreach_conversation_messages_service on public.outreach_conversation_messages for all to service_role using(true) with check(true);
create policy outreach_reply_commands_service on public.outreach_reply_commands for all to service_role using(true) with check(true);
create policy outreach_conversation_reads_service on public.outreach_conversation_reads for all to service_role using(true) with check(true);
revoke all on public.outreach_reply_workspaces,public.outreach_reply_senders,public.outreach_conversations,public.outreach_conversation_messages,public.outreach_reply_commands,public.outreach_conversation_reads from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.outreach_reply_workspaces,public.outreach_reply_senders,public.outreach_conversations,public.outreach_conversation_messages,public.outreach_reply_commands,public.outreach_conversation_reads to service_role;

alter table public.outreach_access_audit drop constraint outreach_access_audit_event_type_check;
alter table public.outreach_access_audit add constraint outreach_access_audit_event_type_check check(event_type in (
 'setup_requested','setup_updated','invitation_created','invitation_revoked','invitation_accepted','membership_updated',
 'account_workspace_configured','account_registered','account_check_started','account_check_completed',
 'conversation_owner_changed','reply_requested','reply_dispatched','reply_completed'
));

create function outreach_private.guard_reply_identity() returns trigger
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
begin
  if new.id<>old.id or new.client_id<>old.client_id or new.channel<>old.channel then
    raise exception using errcode='22023',message='Reply identity cannot change';
  end if;
  if tg_table_name='outreach_reply_senders' and (to_jsonb(new)->'workspace_id' is distinct from to_jsonb(old)->'workspace_id' or to_jsonb(new)->'remote_sender_id' is distinct from to_jsonb(old)->'remote_sender_id') then
    raise exception using errcode='22023',message='Sender identity cannot change';
  end if;
  if tg_table_name='outreach_reply_senders' and (to_jsonb(new)-array['sync_cursor','sync_started_at','synced_at'])=(to_jsonb(old)-array['sync_cursor','sync_started_at','synced_at']) then return new; end if;
  if tg_table_name='outreach_conversations' and (to_jsonb(new)-array['synced_at','updated_at'])=(to_jsonb(old)-array['synced_at','updated_at']) then return new; end if;
  if tg_table_name='outreach_reply_workspaces' and (to_jsonb(new)-'sync_enabled')=(to_jsonb(old)-'sync_enabled') then return new; end if;
  new.version:=old.version+1;
  return new;
end; $$;
revoke all on function outreach_private.guard_reply_identity() from public,anon,authenticated,service_role;
create trigger outreach_reply_workspace_version before update on public.outreach_reply_workspaces for each row execute function outreach_private.guard_reply_identity();
create trigger outreach_reply_sender_version before update on public.outreach_reply_senders for each row execute function outreach_private.guard_reply_identity();
create trigger outreach_conversation_version before update on public.outreach_conversations for each row execute function outreach_private.guard_reply_identity();

create function outreach_private.validate_reply_sender() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if new.channel='email' and new.remote_sender_id<>outreach_private.account_email(new.remote_sender_id) then raise exception using errcode='22023',message='Sender address must be canonical'; end if;
  return new;
end; $$;
revoke all on function outreach_private.validate_reply_sender() from public,anon,authenticated,service_role;
create trigger outreach_reply_sender_validate before insert or update on public.outreach_reply_senders for each row execute function outreach_private.validate_reply_sender();

create function outreach_private.lock_reply_authority(p_client_id uuid,p_actor_id uuid) returns text
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare actor_role text; actor_version bigint;
begin
  perform outreach_private.lock_team_workspace(p_client_id);
  actor_role:=outreach_private.lock_team_role(p_client_id,p_actor_id);
  if actor_role is null or actor_role not in ('agency_owner','operator','client_admin','client_member') then
    raise exception using errcode='42501',message='Reply access denied';
  end if;
  if actor_role='agency_owner' then select version into actor_version from public.outreach_agency_memberships where user_id=p_actor_id;
  else select version into actor_version from public.outreach_memberships where client_id=p_client_id and user_id=p_actor_id; end if;
  return actor_role||':'||actor_version;
end; $$;
revoke all on function outreach_private.lock_reply_authority(uuid,uuid) from public,anon,authenticated,service_role;

create function outreach_private.reply_command(p_row public.outreach_reply_commands) returns jsonb
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select jsonb_build_object('id',p_row.id,'conversationId',p_row.conversation_id,'bodyText',p_row.body_text,
  'status',case when p_row.status='sending' and p_row.expires_at<=clock_timestamp() then 'unknown'
    when p_row.status in ('queued','preparing') and p_row.expires_at<=clock_timestamp() then 'failed'
    when p_row.status in ('queued','preparing') then 'pending' when p_row.status='cancelled' then 'failed' else p_row.status end,
  'createdAt',p_row.created_at,'updatedAt',p_row.updated_at,
  'actorName',coalesce((select nullif(full_name,'') from public.profiles where id=p_row.actor_user_id),'Workspace member'));
$$;
revoke all on function outreach_private.reply_command(public.outreach_reply_commands) from public,anon,authenticated,service_role;

create function outreach_private.conversation_summary(p_row public.outreach_conversations) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare permitted boolean; reason text; sender public.outreach_reply_senders%rowtype; workspace public.outreach_reply_workspaces%rowtype; latest public.outreach_conversation_messages%rowtype;
begin
  permitted:=coalesce(outreach_private.workspace_role(p_row.client_id) in ('agency_owner','operator','client_admin','client_member'),false);
  select * into sender from public.outreach_reply_senders where id=p_row.sender_id;
  select * into workspace from public.outreach_reply_workspaces where id=sender.workspace_id;
  select * into latest from public.outreach_conversation_messages where id=p_row.latest_message_id;
  if not permitted then reason:='Your workspace role has read-only access.';
  elsif p_row.suppressed then reason:='Replies are unavailable for this conversation.';
  elsif sender.id is null or not sender.enabled or not coalesce(workspace.enabled,false) then reason:='Replies are not enabled for this account.';
  elsif latest.id is null or (p_row.channel='email' and not exists(select 1 from public.outreach_conversation_messages where conversation_id=p_row.id and direction='received')) then reason:='A current conversation is required before replying.';
  elsif exists(select 1 from public.outreach_reply_commands where sender_id=sender.id and (status in ('sending','unknown') or (status in ('queued','preparing') and expires_at>clock_timestamp()))) then reason:='A reply is being checked or its outcome needs review.';
  elsif exists(select 1 from public.outreach_reply_commands where conversation_id=p_row.id and status='queued' and expires_at>clock_timestamp()) then reason:='A reply is waiting to send.';
  end if;
  return jsonb_build_object('id',p_row.id,'clientId',p_row.client_id,'channel',p_row.channel,'campaignId',p_row.campaign_id,
   'campaignName',coalesce((select name from public.outreach_campaigns where id=p_row.campaign_id),''),'subject',p_row.subject,
   'contactName',p_row.contact_name,'contactAddress',p_row.contact_address,'senderLabel',coalesce(sender.sender_label,p_row.sender_address),
   'owner',jsonb_build_object('kind',case when p_row.owner_user_id is null then 'covora' else 'user' end,'userId',p_row.owner_user_id,
     'name',case when p_row.owner_user_id is null then 'Covora' else coalesce((select nullif(full_name,'') from public.profiles where id=p_row.owner_user_id),'Workspace member') end),
   'ownedByMe',coalesce(p_row.owner_user_id=auth.uid(),false),'version',p_row.version,'latestMessageId',p_row.latest_message_id,
   'latestAt',p_row.latest_at,'preview',left(coalesce(latest.body_text,''),300),
   'unread',exists(select 1 from public.outreach_conversation_messages m where m.conversation_id=p_row.id and m.direction='received'
       and m.created_at>coalesce((select read_at from public.outreach_conversation_reads where conversation_id=p_row.id and user_id=auth.uid()),'-infinity'::timestamptz)),
   'interest',(select original.interest from public.outreach_conversation_messages m join public.outreach_messages original on original.id=m.source_message_id where m.conversation_id=p_row.id and m.direction='received' order by m.sent_at desc,m.remote_message_id desc limit 1),
   'status',p_row.status,'canReply',reason is null,'canTakeover',permitted,'replyUnavailableReason',reason);
end; $$;
revoke all on function outreach_private.conversation_summary(public.outreach_conversations) from public,anon,authenticated,service_role;

create function public.list_outreach_conversations(p_client_id uuid,p_channel text default 'all',p_limit integer default 51,p_before_at timestamptz default null,p_before_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare result jsonb;
begin
  if not outreach_private.can_read(p_client_id) then raise exception using errcode='42501',message='Conversation access denied'; end if;
  if p_channel is null or p_channel not in ('all','email','linkedin') or p_limit is null or p_limit not between 1 and 100 or (p_before_at is null)<>(p_before_id is null) then raise exception using errcode='22023',message='Invalid conversation request'; end if;
  select coalesce(jsonb_agg(outreach_private.conversation_summary(q) order by q.latest_at desc,q.id desc),'[]'::jsonb) into result
    from (select c.* from public.outreach_conversations c where c.client_id=p_client_id and (p_channel='all' or c.channel=p_channel)
      and (p_before_at is null or (c.latest_at,c.id)<(p_before_at,p_before_id)) order by c.latest_at desc,c.id desc limit p_limit) q;
  return result;
end; $$;
revoke all on function public.list_outreach_conversations(uuid,text,integer,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function public.list_outreach_conversations(uuid,text,integer,timestamptz,uuid) to authenticated;

create function public.read_outreach_conversation(p_client_id uuid,p_conversation_id uuid,p_limit integer default 100,p_before_at timestamptz default null,p_before_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_conversations%rowtype; messages jsonb; commands jsonb; message_count integer;
begin
  if not outreach_private.can_read(p_client_id) then raise exception using errcode='42501',message='Conversation access denied'; end if;
  if p_limit is null or p_limit not between 1 and 100 or (p_before_at is null)<>(p_before_id is null) then raise exception using errcode='22023',message='Invalid conversation request'; end if;
  select * into c from public.outreach_conversations where id=p_conversation_id and client_id=p_client_id;
  if not found then raise exception using errcode='42501',message='Conversation access denied'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'direction',m.direction,'bodyText',m.body_text,'sentAt',m.sent_at,'senderLabel',m.sender_label) order by m.sent_at,m.id),'[]'::jsonb)
    into messages from (select * from public.outreach_conversation_messages where conversation_id=c.id and (p_before_at is null or (sent_at,id)<(p_before_at,p_before_id)) order by sent_at desc,id desc limit p_limit) m;
  select count(*) into message_count from (select id from public.outreach_conversation_messages where conversation_id=c.id and (p_before_at is null or (sent_at,id)<(p_before_at,p_before_id)) limit p_limit+1) m;
  select coalesce(jsonb_agg(outreach_private.reply_command(q) order by q.created_at,q.id),'[]'::jsonb) into commands
    from (select * from public.outreach_reply_commands where conversation_id=c.id order by created_at desc,id desc limit 50) q;
  return outreach_private.conversation_summary(c)||jsonb_build_object('messages',messages,'commands',commands,'messagesTruncated',message_count>p_limit);
end; $$;
revoke all on function public.read_outreach_conversation(uuid,uuid,integer,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_outreach_conversation(uuid,uuid,integer,timestamptz,uuid) to authenticated;

create function public.read_outreach_reply(p_client_id uuid,p_conversation_id uuid,p_command_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare command public.outreach_reply_commands%rowtype;
begin
  if not outreach_private.can_read(p_client_id) then raise exception using errcode='42501',message='Conversation access denied'; end if;
  select * into command from public.outreach_reply_commands where id=p_command_id and client_id=p_client_id and conversation_id=p_conversation_id;
  if not found then raise exception using errcode='42501',message='Conversation access denied'; end if;
  return outreach_private.reply_command(command);
end; $$;
revoke all on function public.read_outreach_reply(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_outreach_reply(uuid,uuid,uuid) to authenticated;

create function public.mark_outreach_conversation_read(p_client_id uuid,p_conversation_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  perform outreach_private.lock_team_workspace(p_client_id);
  if not outreach_private.can_read(p_client_id) or not exists(select 1 from public.outreach_conversations where id=p_conversation_id and client_id=p_client_id) then raise exception using errcode='42501',message='Conversation access denied'; end if;
  insert into public.outreach_conversation_reads(client_id,conversation_id,user_id) values(p_client_id,p_conversation_id,auth.uid())
    on conflict(conversation_id,user_id) do update set read_at=clock_timestamp();
end; $$;
revoke all on function public.mark_outreach_conversation_read(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.mark_outreach_conversation_read(uuid,uuid) to authenticated;

create function outreach_private.expire_replies(p_client_id uuid) returns void
language sql security definer set search_path=pg_catalog,public,pg_temp as $$
 update public.outreach_reply_commands set status=case when status='sending' then 'unknown' else 'failed' end,error_code='lease_expired',updated_at=clock_timestamp()
   where client_id=p_client_id and status in ('queued','sending','preparing') and expires_at<=clock_timestamp();
$$;
revoke all on function outreach_private.expire_replies(uuid) from public,anon,authenticated,service_role;

create function public.change_outreach_conversation_owner(p_client_id uuid,p_conversation_id uuid,p_expected_version bigint,p_owner text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare stamp text; c public.outreach_conversations%rowtype; owner_id uuid;
begin
  stamp:=outreach_private.lock_reply_authority(p_client_id,auth.uid());
  select * into c from public.outreach_conversations where id=p_conversation_id and client_id=p_client_id for update;
  if not found then raise exception using errcode='42501',message='Conversation access denied'; end if;
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
revoke all on function public.change_outreach_conversation_owner(uuid,uuid,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.change_outreach_conversation_owner(uuid,uuid,bigint,text) to authenticated;

create function public.enqueue_outreach_reply(p_client_id uuid,p_conversation_id uuid,p_command_id uuid,p_expected_version bigint,p_latest_message_id uuid,p_body text,p_takeover boolean default false) returns jsonb
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
  if not found then raise exception using errcode='42501',message='Conversation access denied'; end if;
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
revoke all on function public.enqueue_outreach_reply(uuid,uuid,uuid,bigint,uuid,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_outreach_reply(uuid,uuid,uuid,bigint,uuid,text,boolean) to authenticated;

-- User intent is immutable. Service finalization changes only delivery state.
create function outreach_private.guard_reply_command() returns trigger
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
begin
  if (to_jsonb(new)-array['status','claim_token','expires_at','remote_message_id','error_code','updated_at']) is distinct from
     (to_jsonb(old)-array['status','claim_token','expires_at','remote_message_id','error_code','updated_at']) then
    raise exception using errcode='22023',message='Reply intent cannot change';
  end if;
  return new;
end; $$;
revoke all on function outreach_private.guard_reply_command() from public,anon,authenticated,service_role;
create trigger outreach_reply_command_immutable before update on public.outreach_reply_commands for each row execute function outreach_private.guard_reply_command();

-- Caller holds the client row first. The same client lock serializes commands,
-- ownership and mirror changes; binding/authority rows remain locked through commit.
create function outreach_private.reply_is_current(p_command public.outreach_reply_commands) returns boolean
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
    and c.sender_id=sender.id and not c.suppressed and sender.enabled and workspace.enabled
    and sender.version=p_command.sender_version and workspace.version=p_command.workspace_version,false);
end; $$;
revoke all on function outreach_private.reply_is_current(public.outreach_reply_commands) from public,anon,authenticated,service_role;

create function public.claim_outreach_reply(p_command_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare command public.outreach_reply_commands%rowtype; c public.outreach_conversations%rowtype; sender public.outreach_reply_senders%rowtype; workspace public.outreach_reply_workspaces%rowtype; latest public.outreach_conversation_messages%rowtype; token uuid; reply_to text;
begin
  select * into command from public.outreach_reply_commands where id=p_command_id;
  if not found then return null; end if;
  perform 1 from public.clients where id=command.client_id for no key update;
  perform outreach_private.expire_replies(command.client_id);
  select * into command from public.outreach_reply_commands where id=p_command_id for update;
  if command.status<>'queued' then return null; end if;
  if not outreach_private.reply_is_current(command) then
    update public.outreach_reply_commands set status='cancelled',error_code='context_changed',updated_at=clock_timestamp() where id=command.id;
    return null;
  end if;
  -- Authority/config row locks may have waited past the queued deadline.
  -- Never turn an expired intent into a fresh preparation lease.
  if command.expires_at<=clock_timestamp() then
    update public.outreach_reply_commands set status='failed',error_code='lease_expired',updated_at=clock_timestamp() where id=command.id;
    return null;
  end if;
  if exists(select 1 from public.outreach_reply_commands where sender_id=command.sender_id and id<>command.id and status in ('preparing','sending','unknown')) then return null; end if;
  select * into c from public.outreach_conversations where id=command.conversation_id;
  select * into sender from public.outreach_reply_senders where id=c.sender_id;
  select * into workspace from public.outreach_reply_workspaces where id=sender.workspace_id;
  select * into latest from public.outreach_conversation_messages where id=c.latest_message_id;
  select remote_message_id into reply_to from public.outreach_conversation_messages where conversation_id=c.id and direction='received' order by sent_at desc,remote_message_id desc limit 1;
  if latest.id is null or (c.channel='email' and reply_to is null) or (c.channel='linkedin' and latest.remote_fingerprint is null) then
    update public.outreach_reply_commands set status='failed',error_code='context_unavailable',updated_at=clock_timestamp() where id=command.id; return null;
  end if;
  token:=gen_random_uuid();
  update public.outreach_reply_commands set status='preparing',claim_token=token,expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() where id=command.id;
  return jsonb_build_object('claimToken',token,'context',jsonb_build_object(
    'channel',c.channel,'credentialRef',workspace.credential_ref,'remoteWorkspaceId',workspace.remote_workspace_id,
    'remoteSenderId',sender.remote_sender_id,'senderAddress',sender.sender_address,'remoteConversationId',c.remote_conversation_id,
    'remoteReplyToId',case when c.channel='email' then reply_to else null end,'remoteLatestMessageId',case when c.channel='email' then latest.remote_message_id else null end,
    'remoteCampaignId',(select provider_campaign_id from public.outreach_campaigns where id=c.campaign_id),
    'contactAddress',c.contact_address,'latestMessageFingerprint',latest.remote_fingerprint,'subject',c.subject,'bodyText',command.body_text));
end; $$;
revoke all on function public.claim_outreach_reply(uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_outreach_reply(uuid) to service_role;

create function public.dispatch_outreach_reply(p_command_id uuid,p_claim_token uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare command public.outreach_reply_commands%rowtype;
begin
  select * into command from public.outreach_reply_commands where id=p_command_id;
  if not found then return false; end if;
  perform 1 from public.clients where id=command.client_id for no key update;
  perform outreach_private.expire_replies(command.client_id);
  select * into command from public.outreach_reply_commands where id=p_command_id for update;
  if command.status<>'preparing' or command.claim_token is distinct from p_claim_token then return false; end if;
  if not outreach_private.reply_is_current(command) or command.expires_at<=clock_timestamp() then
    update public.outreach_reply_commands set status='cancelled',error_code='context_changed',updated_at=clock_timestamp() where id=command.id; return false;
  end if;
  update public.outreach_reply_commands set status='sending',expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() where id=command.id;
  insert into public.outreach_access_audit(client_id,actor_user_id,subject_id,event_type) values(command.client_id,command.actor_user_id,command.id,'reply_dispatched');
  return true;
end; $$;
revoke all on function public.dispatch_outreach_reply(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.dispatch_outreach_reply(uuid,uuid) to service_role;

create function public.finish_outreach_reply(p_command_id uuid,p_claim_token uuid,p_status text,p_remote_message_id text default null,p_error_code text default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare command public.outreach_reply_commands%rowtype;
begin
  if p_status is null or p_status not in ('sent','failed','unknown') or length(p_remote_message_id)>1000 or
     (p_error_code is not null and p_error_code not in ('prepare_unavailable','prepare_changed','prepare_identity_mismatch','dispatch_unknown','dispatch_rejected')) then
    raise exception using errcode='22023',message='Invalid reply outcome';
  end if;
  select * into command from public.outreach_reply_commands where id=p_command_id;
  if not found then return false; end if;
  -- Retention holds campaign before client through the email bridge. Acquire
  -- that same order before re-opening a fetch job (whose FK locks campaign).
  perform 1 from public.outreach_campaigns campaign join public.outreach_conversations c on c.campaign_id=campaign.id
    where c.id=command.conversation_id for key share of campaign;
  -- A real in-flight result must survive later membership/feature/owner changes.
  perform 1 from public.clients where id=command.client_id for no key update;
  select * into command from public.outreach_reply_commands where id=p_command_id for update;
  if command.claim_token is distinct from p_claim_token or p_claim_token is null then return false; end if;
  if command.status=p_status and command.status in ('sent','failed','unknown') then return true; end if;
  if not (command.status in ('sending','unknown') or (command.status='preparing' and p_status='failed')) then return false; end if;
  update public.outreach_reply_commands set status=p_status,remote_message_id=p_remote_message_id,error_code=p_error_code,updated_at=clock_timestamp() where id=command.id;
  if p_status in ('sent','unknown') and command.channel='email' then
    insert into public.outreach_fetch_queue(campaign_id,client_id,lead_email,provider_thread_id)
      select c.campaign_id,c.client_id,'',c.remote_conversation_id from public.outreach_conversations c
        join public.outreach_campaigns campaign on campaign.id=c.campaign_id
        where c.id=command.conversation_id and campaign.messages_purged_at is null
      on conflict(campaign_id,lead_email,provider_thread_id) do update set
        requested_at=clock_timestamp(),available_at=clock_timestamp(),completed_at=null,cursor=null,attempt_count=0,last_error=null;
  end if;
  if p_status='sent' then update public.outreach_conversations set status='waiting',updated_at=clock_timestamp() where id=command.conversation_id and latest_message_id=command.latest_message_id; end if;
  insert into public.outreach_access_audit(client_id,actor_user_id,subject_id,event_type,details) values(command.client_id,command.actor_user_id,command.id,'reply_completed',jsonb_build_object('status',p_status));
  return true;
end; $$;
revoke all on function public.finish_outreach_reply(uuid,uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_outreach_reply(uuid,uuid,text,text,text) to service_role;

-- Mirror mutations take the same client lock before the conversation lock. The
-- deterministic remote tie-break matches the provider adapter's fingerprint sort.
create function outreach_private.lock_conversation_message() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare target_client uuid; target_conversation uuid;
begin
  if tg_op='UPDATE' and (new.id<>old.id or new.client_id<>old.client_id or new.conversation_id<>old.conversation_id or new.remote_message_id<>old.remote_message_id or new.source_message_id is distinct from old.source_message_id) then raise exception using errcode='22023',message='Message identity cannot change'; end if;
  target_client:=case when tg_op='DELETE' then old.client_id else new.client_id end;
  target_conversation:=case when tg_op='DELETE' then old.conversation_id else new.conversation_id end;
  perform 1 from public.clients where id=target_client for no key update;
  perform 1 from public.outreach_conversations where id=target_conversation for update;
  return case when tg_op='DELETE' then old else new end;
end; $$;
revoke all on function outreach_private.lock_conversation_message() from public,anon,authenticated,service_role;
create trigger outreach_conversation_message_lock before insert or update or delete on public.outreach_conversation_messages for each row execute function outreach_private.lock_conversation_message();

create function outreach_private.refresh_conversation_message() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare target uuid; latest public.outreach_conversation_messages%rowtype;
begin
  if tg_op='UPDATE' and new is not distinct from old then return new; end if;
  target:=case when tg_op='DELETE' then old.conversation_id else new.conversation_id end;
  select * into latest from public.outreach_conversation_messages where conversation_id=target order by sent_at desc,remote_message_id desc limit 1;
  update public.outreach_conversations set version=version+1,latest_message_id=latest.id,latest_at=coalesce(latest.sent_at,latest_at),
    status=case when latest.direction='received' then 'needs_reply' else 'waiting' end,updated_at=clock_timestamp() where id=target;
  return null;
end; $$;
revoke all on function outreach_private.refresh_conversation_message() from public,anon,authenticated,service_role;
create trigger outreach_conversation_message_refresh after insert or update or delete on public.outreach_conversation_messages for each row execute function outreach_private.refresh_conversation_message();

-- Retained email results are the source of truth for imported history. This
-- bridge neither creates a provider account nor enables any reply binding.
create function outreach_private.mirror_email_message(p_message public.outreach_messages) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare thread_id uuid; binding_id uuid; label text;
begin
  perform 1 from public.clients where id=p_message.client_id for no key update;
  if exists(select 1 from public.outreach_campaigns where id=p_message.campaign_id and messages_purged_at is not null) then return; end if;
  select id,sender_label into binding_id,label from public.outreach_reply_senders where client_id=p_message.client_id and channel='email' and remote_sender_id=outreach_private.account_email(p_message.provider_account);
  insert into public.outreach_conversations(client_id,channel,sender_id,campaign_id,source_thread_key,remote_conversation_id,sender_address,contact_name,contact_address,subject)
    values(p_message.client_id,'email',binding_id,p_message.campaign_id,p_message.thread_key,coalesce(p_message.provider_thread_id,p_message.thread_key::text),coalesce(p_message.provider_account,''),'',coalesce(p_message.lead_email,case when p_message.direction='received' then p_message.from_email else p_message.to_email end,''),coalesce(p_message.subject,''))
    on conflict(campaign_id,source_thread_key) do nothing returning id into thread_id;
  if thread_id is null then select id into thread_id from public.outreach_conversations where campaign_id=p_message.campaign_id and source_thread_key=p_message.thread_key; end if;
  -- An existing thread's target stays fixed. Conflicting account or recipient
  -- rows are retained for reading but disable replies until operator review.
  update public.outreach_conversations set suppressed=true,updated_at=clock_timestamp() where id=thread_id and not suppressed and
    (outreach_private.account_email(sender_address) is distinct from outreach_private.account_email(p_message.provider_account)
      or outreach_private.account_email(contact_address) is distinct from outreach_private.account_email(p_message.lead_email)
      or remote_conversation_id is distinct from coalesce(p_message.provider_thread_id,p_message.thread_key::text));
  insert into public.outreach_conversation_messages(client_id,conversation_id,source_message_id,remote_message_id,direction,body_text,sent_at,sender_label,is_auto_reply)
    values(p_message.client_id,thread_id,p_message.id,p_message.provider_email_id,p_message.direction,coalesce(p_message.body_text,''),p_message.sent_at,
      case when p_message.direction='sent' then coalesce(label,p_message.from_email,'') else coalesce(p_message.from_email,p_message.lead_email,'') end,p_message.is_auto_reply)
    on conflict(source_message_id) do update set body_text=excluded.body_text,sent_at=excluded.sent_at,sender_label=excluded.sender_label,direction=excluded.direction,is_auto_reply=excluded.is_auto_reply
    where (outreach_conversation_messages.body_text,outreach_conversation_messages.sent_at,outreach_conversation_messages.sender_label,outreach_conversation_messages.direction,outreach_conversation_messages.is_auto_reply)
      is distinct from (excluded.body_text,excluded.sent_at,excluded.sender_label,excluded.direction,excluded.is_auto_reply);
end; $$;
revoke all on function outreach_private.mirror_email_message(public.outreach_messages) from public,anon,authenticated,service_role;
create function outreach_private.email_message_bridge() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin perform outreach_private.mirror_email_message(new); return new; end; $$;
revoke all on function outreach_private.email_message_bridge() from public,anon,authenticated,service_role;
create trigger outreach_email_message_bridge after insert or update on public.outreach_messages for each row execute function outreach_private.email_message_bridge();

create function outreach_private.attach_email_reply_sender() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if new.channel='email' then
    perform 1 from public.clients where id=new.client_id for no key update;
    update public.outreach_conversations set sender_id=new.id,updated_at=clock_timestamp() where client_id=new.client_id and channel='email' and sender_id is null and outreach_private.account_email(sender_address)=new.remote_sender_id;
  end if;
  return new;
end; $$;
revoke all on function outreach_private.attach_email_reply_sender() from public,anon,authenticated,service_role;
create trigger outreach_email_sender_attach after insert on public.outreach_reply_senders for each row execute function outreach_private.attach_email_reply_sender();

create function outreach_private.purge_reply_history() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if new.messages_purged_at is not null then delete from public.outreach_conversations where campaign_id=new.id; end if;
  return new;
end; $$;
revoke all on function outreach_private.purge_reply_history() from public,anon,authenticated,service_role;
create trigger outreach_reply_history_purge after update of messages_purged_at on public.outreach_campaigns for each row execute function outreach_private.purge_reply_history();

create function public.sync_outreach_linkedin_conversation(p_sender_id uuid,p_remote_conversation_id text,p_contact_name text,p_contact_address text,p_subject text,p_messages jsonb) returns uuid
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare sender public.outreach_reply_senders%rowtype; workspace public.outreach_reply_workspaces%rowtype; item jsonb; thread_id uuid; item_time timestamptz;
begin
  select * into sender from public.outreach_reply_senders where id=p_sender_id and channel='linkedin';
  if not found then raise exception using errcode='42501',message='Conversation binding unavailable'; end if;
  perform outreach_private.lock_team_workspace(sender.client_id);
  select * into sender from public.outreach_reply_senders where id=p_sender_id for share;
  select * into workspace from public.outreach_reply_workspaces where id=sender.workspace_id for share;
  if not coalesce(workspace.sync_enabled,false) then raise exception using errcode='42501',message='Conversation syncing is disabled'; end if;
  if p_remote_conversation_id is null or length(p_remote_conversation_id) not between 1 and 1000 or
    p_contact_name is null or length(p_contact_name)>500 or p_contact_address is null or length(p_contact_address) not between 1 and 1000 or p_subject is null or length(p_subject)>1000 or
    jsonb_typeof(p_messages) is distinct from 'array' then raise exception using errcode='22023',message='Invalid conversation import'; end if;
  if jsonb_array_length(p_messages)>500 then raise exception using errcode='22023',message='Conversation import is too large'; end if;
  insert into public.outreach_conversations(client_id,channel,sender_id,remote_conversation_id,sender_address,contact_name,contact_address,subject,synced_at)
    values(sender.client_id,'linkedin',sender.id,p_remote_conversation_id,sender.sender_address,p_contact_name,p_contact_address,p_subject,clock_timestamp())
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
revoke all on function public.sync_outreach_linkedin_conversation(uuid,text,text,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.sync_outreach_linkedin_conversation(uuid,text,text,text,text,jsonb) to service_role;

-- Backfill only the still-retained mirror. Old purged message bodies stay purged.
do $$ declare source public.outreach_messages%rowtype;
begin for source in select m.* from public.outreach_messages m join public.outreach_campaigns c on c.id=m.campaign_id where c.messages_purged_at is null order by m.sent_at,m.provider_email_id loop
  perform outreach_private.mirror_email_message(source);
end loop; end; $$;
