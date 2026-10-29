-- Portal-started outreach: one sender, one imported prospect, one provider campaign.
-- Only campaigns created here are origin='portal'. Assigned campaigns keep their
-- existing visibility unless the workspace opts into the portal-only inbox.
alter table public.outreach_campaigns
  add column origin text not null default 'assigned' check(origin in ('assigned','portal')),
  add column started_by uuid,
  add constraint outreach_portal_campaign_starter check(origin='assigned' or started_by is not null);

create function outreach_private.guard_campaign_origin() returns trigger
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
begin
  if new.origin is distinct from old.origin or new.started_by is distinct from old.started_by then
    raise exception using errcode='22023',message='Campaign origin cannot change';
  end if;
  return new;
end; $$;
revoke all on function outreach_private.guard_campaign_origin() from public,anon,authenticated,service_role;
create trigger outreach_campaign_origin before update on public.outreach_campaigns
  for each row execute function outreach_private.guard_campaign_origin();

create table public.outreach_portal_sends (
  id uuid primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  actor_user_id uuid not null,
  authority_stamp text not null,
  connection_id uuid not null references public.outreach_connections(id) on delete cascade,
  lead_id uuid not null,
  sender_address text not null check(length(sender_address) between 3 and 254),
  recipient_email text not null check(length(recipient_email) between 3 and 254),
  recipient_first_name text not null default '',
  recipient_last_name text not null default '',
  recipient_company text not null default '',
  subject text not null check(length(subject) between 1 and 500),
  body_text text not null check(length(body_text) between 1 and 4000),
  status text not null default 'queued' check(status in ('queued','creating','scheduled','sent','failed','unknown')),
  claim_token uuid,
  expires_at timestamptz not null default (clock_timestamp()+interval '60 seconds'),
  campaign_id uuid references public.outreach_campaigns(id) on delete set null,
  provider_campaign_id text check(length(provider_campaign_id) between 1 and 200),
  provider_lead_id text check(length(provider_lead_id) between 1 and 200),
  provider_email_id text check(length(provider_email_id) between 1 and 1000),
  provider_thread_id text check(length(provider_thread_id) between 1 and 1000),
  error_code text check(error_code is null or error_code in ('prepare_unavailable','prepare_identity_mismatch','dispatch_rejected','dispatch_unknown','lease_expired')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check(status not in ('scheduled','sent') or (provider_campaign_id is not null and provider_lead_id is not null))
);
create unique index outreach_portal_send_campaign on public.outreach_portal_sends(campaign_id) where campaign_id is not null;
create unique index outreach_portal_send_provider_campaign on public.outreach_portal_sends(provider_campaign_id) where provider_campaign_id is not null;
-- One provider creation in flight per sender; ambiguous outcomes are never retried automatically.
create unique index outreach_portal_send_one_active on public.outreach_portal_sends(connection_id) where status in ('queued','creating');
create index outreach_portal_send_history on public.outreach_portal_sends(client_id,actor_user_id,created_at desc,id desc);

-- Webhook deliveries are deduplicated before any queue change. Only hashes are stored.
create table public.outreach_webhook_events (
  event_key text primary key check(event_key ~ '^[a-f0-9]{64}$'),
  campaign_id uuid references public.outreach_campaigns(id) on delete cascade,
  matched boolean not null,
  received_at timestamptz not null default clock_timestamp()
);

alter table public.outreach_portal_sends enable row level security;
alter table public.outreach_webhook_events enable row level security;
create policy outreach_portal_sends_service on public.outreach_portal_sends for all to service_role using(true) with check(true);
create policy outreach_webhook_events_service on public.outreach_webhook_events for all to service_role using(true) with check(true);
revoke all on public.outreach_portal_sends,public.outreach_webhook_events from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.outreach_portal_sends,public.outreach_webhook_events to service_role;

create function outreach_private.portal_inbox_only(p_client_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select exists(select 1 from public.client_features f where f.client_id=p_client_id and f.feature='outreach_portal_inbox' and f.enabled);
$$;
revoke all on function outreach_private.portal_inbox_only(uuid) from public,anon,authenticated,service_role;

-- Portal threads belong to their starter; workspace administrators may supervise them.
-- Service-role callers (sync, reply claim/dispatch) have no auth.uid() and keep the
-- original campaign scope; user-initiated reply intent is already checked here.
create or replace function outreach_private.conversation_campaign_allowed(p_row public.outreach_conversations) returns boolean
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select (p_row.channel='email' or exists(select 1 from public.outreach_campaigns c
      where c.id=p_row.campaign_id and c.client_id=p_row.client_id and c.channel='linkedin' and c.messages_purged_at is null))
    and (auth.uid() is null or coalesce((
      select case when c.origin='portal' then c.started_by=auth.uid()
          or coalesce(outreach_private.workspace_role(p_row.client_id) in ('agency_owner','operator','client_admin'),false)
        else not outreach_private.portal_inbox_only(p_row.client_id) end
      from public.outreach_campaigns c where c.id=p_row.campaign_id and c.client_id=p_row.client_id),
      not outreach_private.portal_inbox_only(p_row.client_id)));
$$;
revoke all on function outreach_private.conversation_campaign_allowed(public.outreach_conversations) from public,anon,authenticated,service_role;

-- A portal thread is listed as soon as its first message is mirrored, so the
-- starter can follow it before a reply. Other email threads still need a reply.
create or replace function public.list_outreach_conversations(p_client_id uuid,p_channel text default 'all',p_limit integer default 51,p_before_at timestamptz default null,p_before_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare result jsonb;
begin
  if not outreach_private.can_read(p_client_id) then raise exception using errcode='42501',message='Conversation access denied'; end if;
  if p_channel is null or p_channel not in ('all','email','linkedin') or p_limit is null or p_limit not between 1 and 100 or (p_before_at is null)<>(p_before_id is null) then raise exception using errcode='22023',message='Invalid conversation request'; end if;
  select coalesce(jsonb_agg(outreach_private.conversation_summary(q) order by q.latest_at desc,q.id desc),'[]'::jsonb) into result
    from (select c.* from public.outreach_conversations c where c.client_id=p_client_id and outreach_private.conversation_campaign_allowed(c) and (p_channel='all' or c.channel=p_channel)
      and (c.channel<>'email' or exists(select 1 from public.outreach_conversation_messages m where m.conversation_id=c.id and m.client_id=c.client_id and m.direction='received')
        or exists(select 1 from public.outreach_campaigns k where k.id=c.campaign_id and k.client_id=c.client_id and k.origin='portal'))
      and (p_before_at is null or (c.latest_at,c.id)<(p_before_at,p_before_id)) order by c.latest_at desc,c.id desc limit p_limit) q;
  return result;
end; $$;

-- The starter owns a newly mirrored portal thread, so replying needs no takeover.
create function outreach_private.portal_conversation_owner() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if new.owner_user_id is null and new.campaign_id is not null then
    select started_by into new.owner_user_id from public.outreach_campaigns
      where id=new.campaign_id and client_id=new.client_id and origin='portal';
  end if;
  return new;
end; $$;
revoke all on function outreach_private.portal_conversation_owner() from public,anon,authenticated,service_role;
create trigger outreach_portal_conversation_owner before insert on public.outreach_conversations
  for each row execute function outreach_private.portal_conversation_owner();

-- Record the provider email/thread of the first mirrored portal message.
create function outreach_private.portal_send_observed() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if new.direction='sent' then
    update public.outreach_portal_sends set provider_email_id=coalesce(provider_email_id,new.provider_email_id),
      provider_thread_id=coalesce(provider_thread_id,new.provider_thread_id),
      status=case when status in ('scheduled','unknown') and provider_lead_id is not null then 'sent' else status end,updated_at=clock_timestamp()
      where campaign_id=new.campaign_id and client_id=new.client_id and (provider_email_id is null or status in ('scheduled','unknown'));
  end if;
  return new;
end; $$;
revoke all on function outreach_private.portal_send_observed() from public,anon,authenticated,service_role;
create trigger outreach_portal_send_observed after insert on public.outreach_messages
  for each row execute function outreach_private.portal_send_observed();

create function outreach_private.portal_send(p_row public.outreach_portal_sends) returns jsonb
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select jsonb_build_object('id',p_row.id,'clientId',p_row.client_id,
    'status',case when p_row.status='creating' and p_row.expires_at<=clock_timestamp() then 'unknown'
      when p_row.status='queued' and p_row.expires_at<=clock_timestamp() then 'failed' else p_row.status end,
    'recipientEmail',p_row.recipient_email,'recipientName',btrim(p_row.recipient_first_name||' '||p_row.recipient_last_name),
    'senderAddress',p_row.sender_address,'subject',p_row.subject,'createdAt',p_row.created_at,'updatedAt',p_row.updated_at,
    'conversationId',(select c.id from public.outreach_conversations c where p_row.campaign_id is not null and c.campaign_id=p_row.campaign_id and c.client_id=p_row.client_id order by c.created_at,c.id limit 1));
$$;
revoke all on function outreach_private.portal_send(public.outreach_portal_sends) from public,anon,authenticated,service_role;

create function outreach_private.expire_portal_sends(p_client_id uuid) returns void
language sql security definer set search_path=pg_catalog,public,pg_temp as $$
  update public.outreach_portal_sends set status=case when status='creating' then 'unknown' else 'failed' end,error_code='lease_expired',updated_at=clock_timestamp()
    where client_id=p_client_id and status in ('queued','creating') and expires_at<=clock_timestamp();
$$;
revoke all on function outreach_private.expire_portal_sends(uuid) from public,anon,authenticated,service_role;

-- The sender must be the actor's own connected mailbox, not bound to another client.
create function outreach_private.portal_sender(p_client_id uuid,p_connection_id uuid,p_user_id uuid) returns text
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select outreach_private.account_email(c.expected_email) from public.outreach_connections c join public.outreach_people p on p.id=c.person_id and p.client_id=c.client_id
    where c.id=p_connection_id and c.client_id=p_client_id and c.channel='email' and c.state='connected' and p.user_id=p_user_id
      and not exists(select 1 from public.outreach_reply_senders s where s.channel='email' and s.remote_sender_id=outreach_private.account_email(c.expected_email) and s.client_id<>p_client_id);
$$;
revoke all on function outreach_private.portal_sender(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.portal_outreach_options(p_client_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if coalesce(outreach_private.workspace_role(p_client_id) not in ('agency_owner','operator','client_admin','client_member'),true) then
    raise exception using errcode='42501',message='Outreach access denied';
  end if;
  return jsonb_build_object(
    'prospects',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'name',btrim(l.first_name||' '||l.last_name),'email',lower(l.email),'company',l.company) order by lower(l.company),l.id)
      from (select * from public.outreach_imported_leads where client_id=p_client_id and email is not null and review_state='client' order by lower(company),id limit 500) l),'[]'::jsonb),
    'senders',coalesce((select jsonb_agg(jsonb_build_object('connectionId',c.id,'address',outreach_private.account_email(c.expected_email),'label',p.name) order by c.created_at,c.id)
      from public.outreach_connections c join public.outreach_people p on p.id=c.person_id and p.client_id=c.client_id
      where c.client_id=p_client_id and c.channel='email' and c.state='connected' and p.user_id=auth.uid()
        and outreach_private.portal_sender(p_client_id,c.id,auth.uid()) is not null),'[]'::jsonb));
end; $$;
revoke all on function public.portal_outreach_options(uuid) from public,anon,authenticated,service_role;
grant execute on function public.portal_outreach_options(uuid) to authenticated;

create function public.list_portal_outreach(p_client_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare supervisor boolean;
begin
  if coalesce(outreach_private.workspace_role(p_client_id) not in ('agency_owner','operator','client_admin','client_member'),true) then
    raise exception using errcode='42501',message='Outreach access denied';
  end if;
  supervisor:=outreach_private.workspace_role(p_client_id) in ('agency_owner','operator','client_admin');
  return coalesce((select jsonb_agg(outreach_private.portal_send(s) order by s.created_at desc,s.id desc)
    from (select * from public.outreach_portal_sends where client_id=p_client_id and (supervisor or actor_user_id=auth.uid())
      order by created_at desc,id desc limit 25) s),'[]'::jsonb);
end; $$;
revoke all on function public.list_portal_outreach(uuid) from public,anon,authenticated,service_role;
grant execute on function public.list_portal_outreach(uuid) to authenticated;

create function public.enqueue_portal_outreach(p_client_id uuid,p_send_id uuid,p_lead_id uuid,p_connection_id uuid,p_subject text,p_body text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare stamp text; existing public.outreach_portal_sends%rowtype; created public.outreach_portal_sends%rowtype; lead public.outreach_imported_leads%rowtype; sender text; subject text; body text;
begin
  stamp:=outreach_private.lock_reply_authority(p_client_id,auth.uid());
  subject:=btrim(p_subject,E' \t\n\r\f\013');
  body:=btrim(p_body,E' \t\n\r\f\013');
  if p_send_id is null or subject is null or length(subject) not between 1 and 500 or subject ~ '[\r\n]' or body is null or length(body) not between 1 and 4000 then
    raise exception using errcode='22023',message='Invalid outreach';
  end if;
  select * into existing from public.outreach_portal_sends where id=p_send_id;
  if found then
    if existing.client_id<>p_client_id or existing.actor_user_id<>auth.uid() or existing.lead_id<>p_lead_id or existing.connection_id<>p_connection_id
      or existing.subject<>subject or existing.body_text<>body then raise exception using errcode='22023',message='Outreach request does not match its original content'; end if;
    return outreach_private.portal_send(existing);
  end if;
  perform outreach_private.expire_portal_sends(p_client_id);
  if not exists(select 1 from public.outreach_reply_workspaces where client_id=p_client_id and channel='email' and enabled) then
    raise exception using errcode='42501',message='Outreach is unavailable for this workspace';
  end if;
  select * into lead from public.outreach_imported_leads where id=p_lead_id and client_id=p_client_id and email is not null and review_state='client';
  if not found then raise exception using errcode='42501',message='Prospect unavailable'; end if;
  sender:=outreach_private.portal_sender(p_client_id,p_connection_id,auth.uid());
  if sender is null then raise exception using errcode='42501',message='Choose one of your connected sender accounts'; end if;
  insert into public.outreach_portal_sends(id,client_id,actor_user_id,authority_stamp,connection_id,lead_id,sender_address,recipient_email,
      recipient_first_name,recipient_last_name,recipient_company,subject,body_text)
    values(p_send_id,p_client_id,auth.uid(),stamp,p_connection_id,lead.id,sender,lower(lead.email),lead.first_name,lead.last_name,lead.company,subject,body)
    returning * into created;
  return outreach_private.portal_send(created);
exception when unique_violation then raise exception using errcode='22023',message='Wait for the current outreach from this sender';
end; $$;
revoke all on function public.enqueue_portal_outreach(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_portal_outreach(uuid,uuid,uuid,uuid,text,text) to authenticated;

create function public.read_portal_outreach(p_client_id uuid,p_send_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare item public.outreach_portal_sends%rowtype;
begin
  if not outreach_private.can_read(p_client_id) then raise exception using errcode='42501',message='Outreach access denied'; end if;
  select * into item from public.outreach_portal_sends where id=p_send_id and client_id=p_client_id;
  if not found or (item.actor_user_id<>auth.uid() and coalesce(outreach_private.workspace_role(p_client_id) not in ('agency_owner','operator','client_admin'),true)) then
    raise exception using errcode='42501',message='Outreach access denied';
  end if;
  return outreach_private.portal_send(item);
end; $$;
revoke all on function public.read_portal_outreach(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_portal_outreach(uuid,uuid) to authenticated;

-- Service-only: rechecks the actor's authority and sender ownership before any provider write.
create function public.claim_portal_outreach(p_send_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare s public.outreach_portal_sends%rowtype; w public.outreach_reply_workspaces%rowtype; stamp text; token uuid;
begin
  select * into s from public.outreach_portal_sends where id=p_send_id;
  if not found then return null; end if;
  perform 1 from public.clients where id=s.client_id for no key update;
  perform outreach_private.expire_portal_sends(s.client_id);
  select * into s from public.outreach_portal_sends where id=p_send_id for update;
  if s.status<>'queued' then return null; end if;
  begin stamp:=outreach_private.lock_reply_authority(s.client_id,s.actor_user_id);
  exception when insufficient_privilege then stamp:=null; end;
  select * into w from public.outreach_reply_workspaces where client_id=s.client_id and channel='email' for share;
  if stamp is distinct from s.authority_stamp or not coalesce(w.enabled,false)
    or outreach_private.portal_sender(s.client_id,s.connection_id,s.actor_user_id) is distinct from s.sender_address then
    update public.outreach_portal_sends set status='failed',error_code='prepare_identity_mismatch',updated_at=clock_timestamp() where id=s.id;
    return null;
  end if;
  token:=gen_random_uuid();
  update public.outreach_portal_sends set status='creating',claim_token=token,expires_at=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp() where id=s.id;
  return jsonb_build_object('claimToken',token,'context',jsonb_build_object('credentialRef',w.credential_ref,'remoteWorkspaceId',w.remote_workspace_id,
    'senderAddress',s.sender_address,'recipientEmail',s.recipient_email,'recipientFirstName',s.recipient_first_name,'recipientLastName',s.recipient_last_name,
    'recipientCompany',s.recipient_company,'subject',s.subject,'bodyText',s.body_text,'campaignName','Covora outreach '||left(s.id::text,8)));
end; $$;
revoke all on function public.claim_portal_outreach(uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_portal_outreach(uuid) to service_role;

-- Any created provider campaign is recorded, even after an ambiguous later step,
-- so the backup sync and operators can see it. Its sender becomes a reply binding.
create function public.finish_portal_outreach(p_send_id uuid,p_claim_token uuid,p_status text,p_provider_campaign_id text default null,p_provider_lead_id text default null,p_error_code text default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare s public.outreach_portal_sends%rowtype; w public.outreach_reply_workspaces%rowtype; campaign uuid; person_name text;
begin
  if p_status is null or p_status not in ('scheduled','failed','unknown') or (p_status='scheduled' and (p_provider_campaign_id is null or p_provider_lead_id is null))
    or length(p_provider_campaign_id) not between 1 and 200 or length(p_provider_lead_id) not between 1 and 200
    or (p_error_code is not null and p_error_code not in ('prepare_unavailable','prepare_identity_mismatch','dispatch_rejected','dispatch_unknown')) then
    raise exception using errcode='22023',message='Invalid outreach outcome';
  end if;
  select * into s from public.outreach_portal_sends where id=p_send_id;
  if not found then return false; end if;
  perform 1 from public.clients where id=s.client_id for no key update;
  select * into s from public.outreach_portal_sends where id=p_send_id for update;
  if p_claim_token is null or s.claim_token is distinct from p_claim_token then return false; end if;
  if s.status=p_status and s.status in ('scheduled','failed','unknown') then return true; end if;
  -- An expired lease is already 'unknown'; a late real result may still resolve it.
  if s.status not in ('creating','unknown') then return false; end if;
  if p_provider_campaign_id is not null then
    insert into public.outreach_campaigns(client_id,provider_campaign_id,name,status,channel,origin,started_by)
      values(s.client_id,p_provider_campaign_id,'Covora outreach '||left(s.id::text,8),case when p_status='scheduled' then 'active' else 'draft' end,'email','portal',s.actor_user_id)
      on conflict(provider_campaign_id) do nothing returning id into campaign;
    if campaign is null then
      select id into campaign from public.outreach_campaigns where provider_campaign_id=p_provider_campaign_id and client_id=s.client_id and origin='portal' and started_by=s.actor_user_id;
      if campaign is null then raise exception using errcode='22023',message='Provider campaign identity conflict'; end if;
    end if;
    select * into w from public.outreach_reply_workspaces where client_id=s.client_id and channel='email';
    select p.name into person_name from public.outreach_connections c join public.outreach_people p on p.id=c.person_id where c.id=s.connection_id;
    insert into public.outreach_reply_senders(client_id,channel,workspace_id,remote_sender_id,sender_address,sender_label,enabled)
      values(s.client_id,'email',w.id,s.sender_address,s.sender_address,left(coalesce(nullif(person_name,''),s.sender_address),200),true)
      on conflict(channel,remote_sender_id) do nothing;
  end if;
  update public.outreach_portal_sends set status=p_status,campaign_id=coalesce(campaign,campaign_id),
    provider_campaign_id=coalesce(p_provider_campaign_id,provider_campaign_id),provider_lead_id=coalesce(p_provider_lead_id,provider_lead_id),
    error_code=p_error_code,updated_at=clock_timestamp() where id=s.id;
  return true;
end; $$;
revoke all on function public.finish_portal_outreach(uuid,uuid,text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_portal_outreach(uuid,uuid,text,text,text,text) to service_role;

-- Webhook: only a portal campaign already recorded here can request a scoped fetch.
-- The payload itself is never stored; the sync worker re-reads the provider.
create function public.record_instantly_reply_event(p_event_key text,p_provider_campaign_id text,p_lead_email text) returns text
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare campaign public.outreach_campaigns%rowtype; lead text;
begin
  if p_event_key is null or p_event_key !~ '^[a-f0-9]{64}$' or p_provider_campaign_id is null or length(p_provider_campaign_id) not between 1 and 200
    or p_lead_email is null or length(p_lead_email) not between 3 and 254 then raise exception using errcode='22023',message='Invalid event'; end if;
  lead:=outreach_private.account_email(p_lead_email);
  select * into campaign from public.outreach_campaigns where provider_campaign_id=p_provider_campaign_id and origin='portal' and channel='email' and messages_purged_at is null;
  insert into public.outreach_webhook_events(event_key,campaign_id,matched) values(p_event_key,campaign.id,campaign.id is not null) on conflict(event_key) do nothing;
  if not found then return 'duplicate'; end if;
  if campaign.id is null or not exists(select 1 from public.outreach_portal_sends where campaign_id=campaign.id and recipient_email=lead) then return 'ignored'; end if;
  insert into public.outreach_fetch_queue(campaign_id,client_id,lead_email,provider_thread_id) values(campaign.id,campaign.client_id,lead,'')
    on conflict(campaign_id,lead_email,provider_thread_id) do update set
      requested_at=clock_timestamp(),available_at=clock_timestamp(),completed_at=null,cursor=null,attempt_count=0,last_error=null;
  return 'queued';
end; $$;
revoke all on function public.record_instantly_reply_event(text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.record_instantly_reply_event(text,text,text) to service_role;

notify pgrst,'reload schema';
