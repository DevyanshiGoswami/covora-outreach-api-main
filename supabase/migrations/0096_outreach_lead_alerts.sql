-- Extracted for the independent outbound platform; see docs/schema-extraction.md.
-- Explicit client lead alerts. No existing client is opted in by this migration.
-- Network dispatch remains a worker concern behind its separate deployment gate.
create table public.outreach_lead_alert_policies (
  client_id uuid not null,
  user_id uuid not null,
  enabled boolean not null default false,
  threshold integer not null default 5 check (threshold between 1 and 100),
  cooldown_hours integer not null default 24 check (cooldown_hours between 1 and 168),
  enabled_at timestamptz,
  version bigint not null default 1 check (version > 0),
  configured_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  last_scanned_at timestamptz,
  primary key (client_id,user_id),
  foreign key (user_id,client_id) references public.outreach_memberships(user_id,client_id) on delete cascade,
  check (not enabled or enabled_at is not null)
);
create index outreach_lead_alert_policy_scan on public.outreach_lead_alert_policies(last_scanned_at nulls first,client_id,user_id) where enabled;

create table public.outreach_lead_alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  recipient_email text not null,
  policy_version bigint not null,
  policy_enabled_at timestamptz not null,
  membership_version bigint not null,
  threshold integer not null check (threshold between 1 and 100),
  status text not null default 'preparing' check (status in ('preparing','dispatching','sent','failed','unknown','cancelled')),
  claim_token uuid not null default gen_random_uuid(),
  lead_count integer not null check (lead_count >= 0),
  expires_at timestamptz not null default (clock_timestamp()+interval '60 seconds'),
  error_code text check (error_code ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz not null default clock_timestamp(),
  dispatched_at timestamptz,
  finished_at timestamptz,
  unique (id,client_id,user_id)
);
create unique index outreach_lead_alert_one_active on public.outreach_lead_alert_deliveries(client_id,user_id)
  where status in ('preparing','dispatching','unknown');
create index outreach_lead_alert_history on public.outreach_lead_alert_deliveries(client_id,user_id,created_at desc);

-- Receipts intentionally have no FK to retained conversations/messages or to
-- a policy/membership. Removing source history or recreating a policy must not
-- resurrect a lead already notified. Store a contact hash, never reply copy.
create table public.outreach_lead_alert_items (
  delivery_id uuid not null,
  client_id uuid not null,
  user_id uuid not null,
  contact_key text not null check (contact_key ~ '^[a-f0-9]{64}$'),
  conversation_id uuid not null,
  latest_message_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (client_id,user_id,contact_key),
  unique (client_id,user_id,conversation_id,latest_message_id),
  foreign key (delivery_id,client_id,user_id) references public.outreach_lead_alert_deliveries(id,client_id,user_id) on delete cascade
);
create index outreach_lead_alert_items_delivery on public.outreach_lead_alert_items(delivery_id);

alter table public.outreach_lead_alert_policies enable row level security;
alter table public.outreach_lead_alert_deliveries enable row level security;
alter table public.outreach_lead_alert_items enable row level security;
create policy outreach_lead_alert_policies_service on public.outreach_lead_alert_policies for all to service_role using(true) with check(true);
create policy outreach_lead_alert_deliveries_service on public.outreach_lead_alert_deliveries for all to service_role using(true) with check(true);
create policy outreach_lead_alert_items_service on public.outreach_lead_alert_items for all to service_role using(true) with check(true);
revoke all on public.outreach_lead_alert_policies,public.outreach_lead_alert_deliveries,public.outreach_lead_alert_items from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.outreach_lead_alert_policies,public.outreach_lead_alert_deliveries,public.outreach_lead_alert_items to service_role;

create function outreach_private.guard_lead_alert_policy() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if tg_op='INSERT' then
    new.version:=1;
    new.created_at:=clock_timestamp();
    new.enabled_at:=case when new.enabled then clock_timestamp() else null end;
  else
    -- Reservation is worker bookkeeping, not an owner reconfiguration. Avoid
    -- changing the consent version or rechecking a now-revoked recipient here.
    if new.last_scanned_at is distinct from old.last_scanned_at
      and (to_jsonb(new)-'last_scanned_at')=(to_jsonb(old)-'last_scanned_at') then
      return new;
    end if;
    if new.client_id<>old.client_id or new.user_id<>old.user_id then
      raise exception using errcode='22023',message='Alert recipient identity cannot change';
    end if;
    -- An explicit owner reconfiguration also releases a confirmed-failure
    -- quarantine. Even re-applying identical settings creates a new version.
    new.version:=old.version+1;
    new.created_at:=old.created_at;
    new.enabled_at:=case when new.enabled and not old.enabled then clock_timestamp() else old.enabled_at end;
  end if;
  new.updated_at:=clock_timestamp();
  if new.enabled and not exists (
    select 1 from public.outreach_memberships m join auth.users u on u.id=m.user_id
    join public.client_features f on f.client_id=m.client_id and f.feature='outreach_app' and f.enabled
    where m.client_id=new.client_id and m.user_id=new.user_id and m.state='active'
      and m.role in ('client_admin','client_member') and u.email_confirmed_at is not null
      and u.deleted_at is null and (u.banned_until is null or u.banned_until<=clock_timestamp())
      and outreach_private.account_email(u.email) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ) then raise exception using errcode='42501',message='Alert recipient is unavailable'; end if;
  return new;
end; $$;
revoke all on function outreach_private.guard_lead_alert_policy() from public,anon,authenticated,service_role;
create trigger outreach_lead_alert_policy_guard before insert or update on public.outreach_lead_alert_policies
  for each row execute function outreach_private.guard_lead_alert_policy();

create function outreach_private.lead_alert_policy_json(p_row public.outreach_lead_alert_policies) returns jsonb
language sql immutable set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('clientId',p_row.client_id,'userId',p_row.user_id,'enabled',p_row.enabled,
    'threshold',p_row.threshold,'cooldownHours',p_row.cooldown_hours,'enabledAt',p_row.enabled_at,'version',p_row.version);
$$;
revoke all on function outreach_private.lead_alert_policy_json(public.outreach_lead_alert_policies) from public,anon,authenticated,service_role;

create function public.configure_outreach_lead_alert(p_client_id uuid,p_user_id uuid,p_enabled boolean,p_threshold integer default 5,p_cooldown_hours integer default 24) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare policy public.outreach_lead_alert_policies%rowtype;
begin
  perform 1 from public.clients where id=p_client_id for no key update;
  if not found then raise exception using errcode='42501',message='Alert configuration access denied'; end if;
  perform 1 from public.outreach_agency_memberships where user_id=auth.uid() and state='active' for share;
  if not found then raise exception using errcode='42501',message='Alert configuration access denied'; end if;
  perform 1 from auth.users where id=auth.uid() and email_confirmed_at is not null and deleted_at is null
    and (banned_until is null or banned_until<=clock_timestamp()) for share;
  if not found then raise exception using errcode='42501',message='Alert configuration access denied'; end if;
  if p_enabled is null or p_threshold is null or p_threshold not between 1 and 100
    or p_cooldown_hours is null or p_cooldown_hours not between 1 and 168 then
    raise exception using errcode='22023',message='Invalid alert policy';
  end if;
  perform 1 from public.outreach_memberships where client_id=p_client_id and user_id=p_user_id for share;
  if not found then raise exception using errcode='42501',message='Alert recipient is unavailable'; end if;
  perform 1 from auth.users where id=p_user_id for share;
  perform 1 from public.client_features where client_id=p_client_id and feature='outreach_app' for share;
  insert into public.outreach_lead_alert_policies(client_id,user_id,enabled,threshold,cooldown_hours,configured_by)
    values(p_client_id,p_user_id,p_enabled,p_threshold,p_cooldown_hours,auth.uid())
    on conflict(client_id,user_id) do update set enabled=excluded.enabled,threshold=excluded.threshold,
      cooldown_hours=excluded.cooldown_hours,configured_by=auth.uid()
    returning * into policy;
  return outreach_private.lead_alert_policy_json(policy);
end; $$;
revoke all on function public.configure_outreach_lead_alert(uuid,uuid,boolean,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.configure_outreach_lead_alert(uuid,uuid,boolean,integer,integer) to authenticated;

-- Reserve oldest policies before doing slow work so an interrupted tick does
-- not repeatedly start at the first page. No client/recipient locks are taken
-- here: all authorization and eligibility are rechecked by claim and dispatch.
create function public.reserve_outreach_lead_alert_policies(p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare result jsonb;
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception using errcode='22023',message='Invalid alert reservation limit';
  end if;
  with candidates as (
    select client_id,user_id from public.outreach_lead_alert_policies
    where enabled and (last_scanned_at is null or last_scanned_at<clock_timestamp()-interval '60 seconds')
    order by last_scanned_at nulls first,client_id,user_id
    limit p_limit for update skip locked
  ), reserved as (
    update public.outreach_lead_alert_policies p set last_scanned_at=clock_timestamp()
    from candidates c where p.client_id=c.client_id and p.user_id=c.user_id
    returning p.client_id,p.user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('clientId',client_id,'userId',user_id) order by client_id,user_id),'[]'::jsonb)
    into result from reserved;
  return result;
end; $$;
revoke all on function public.reserve_outreach_lead_alert_policies(integer) from public,anon,authenticated,service_role;
grant execute on function public.reserve_outreach_lead_alert_policies(integer) to service_role;

-- Retention takes campaign before client, and mirror/reply/read operations
-- serialize on this same client row. Never lock source messages after client:
-- an in-flight source UPDATE may own that row while waiting for the bridge's
-- client lock. Its uncommitted change correctly linearizes after dispatch.
create function outreach_private.lock_lead_alert_scope(p_client_id uuid,p_user_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  perform 1 from public.outreach_campaigns where client_id=p_client_id order by id for share;
  perform 1 from public.clients where id=p_client_id for no key update;
  perform 1 from public.client_features where client_id=p_client_id and feature='outreach_app' for share;
  perform 1 from public.outreach_memberships where client_id=p_client_id and user_id=p_user_id for share;
  perform 1 from auth.users where id=p_user_id for share;
end; $$;
revoke all on function outreach_private.lock_lead_alert_scope(uuid,uuid) from public,anon,authenticated,service_role;

create function outreach_private.lead_alert_recipient(p_client_id uuid,p_user_id uuid)
returns table(email text,membership_version bigint)
language sql set search_path=pg_catalog,public,pg_temp as $$
  select outreach_private.account_email(u.email),m.version
  from public.outreach_memberships m join auth.users u on u.id=m.user_id
  join public.client_features f on f.client_id=m.client_id and f.feature='outreach_app' and f.enabled
  where m.client_id=p_client_id and m.user_id=p_user_id and m.state='active'
    and m.role in ('client_admin','client_member') and u.email_confirmed_at is not null
    and u.deleted_at is null and (u.banned_until is null or u.banned_until<=clock_timestamp())
    and outreach_private.account_email(u.email) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';
$$;
revoke all on function outreach_private.lead_alert_recipient(uuid,uuid) from public,anon,authenticated,service_role;

create function outreach_private.eligible_lead_alert_items(p_client_id uuid,p_user_id uuid,p_enabled_at timestamptz,p_delivery_id uuid default null)
returns table(contact_key text,conversation_id uuid,latest_message_id uuid)
language sql set search_path=pg_catalog,public,pg_temp as $$
  with ranked as (
    -- Rank ALL current threads for a contact before filtering. A newer
    -- negative, automatic, suppressed or answered thread defeats stale interest.
    select distinct on (outreach_private.account_email(c.contact_address)) c.*,
      outreach_private.account_email(c.contact_address) normalized_contact
    from public.outreach_conversations c
    where c.client_id=p_client_id and c.channel='email'
      and outreach_private.account_email(c.contact_address) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    order by outreach_private.account_email(c.contact_address),c.latest_at desc,c.id desc
  ), eligible as (
    select encode(extensions.digest(c.normalized_contact,'sha256'),'hex') contact_key,c.id conversation_id,m.id latest_message_id
    from ranked c join public.outreach_conversation_messages m on m.id=c.latest_message_id and m.conversation_id=c.id and m.client_id=c.client_id
    join public.outreach_messages original on original.id=m.source_message_id and original.client_id=c.client_id and original.campaign_id=c.campaign_id
    left join public.outreach_conversation_reads r on r.conversation_id=c.id and r.user_id=p_user_id and r.client_id=p_client_id
    where c.status='needs_reply' and not c.suppressed and m.direction='received' and not m.is_auto_reply
      and original.direction='received' and not original.is_auto_reply and original.interest='Interested'
      and original.sent_at>p_enabled_at and m.sent_at=original.sent_at
      and outreach_private.account_email(coalesce(original.lead_email,original.from_email))=c.normalized_contact
      and (r.read_at is null or r.read_at<m.created_at)
      and not exists(select 1 from public.outreach_reply_commands q where q.client_id=p_client_id and q.conversation_id=c.id
        and q.latest_message_id=m.id and q.status in ('queued','preparing','sending','sent','unknown'))
  )
  select e.contact_key,e.conversation_id,e.latest_message_id from eligible e
  where not exists(select 1 from public.outreach_lead_alert_items i
    where i.client_id=p_client_id and i.user_id=p_user_id and i.contact_key=e.contact_key
      and i.delivery_id is distinct from p_delivery_id)
  order by e.contact_key limit 1000;
$$;
revoke all on function outreach_private.eligible_lead_alert_items(uuid,uuid,timestamptz,uuid) from public,anon,authenticated,service_role;

create function outreach_private.expire_lead_alerts(p_client_id uuid,p_user_id uuid) returns void
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
begin
  update public.outreach_lead_alert_deliveries set status=case when status='dispatching' then 'unknown' else 'cancelled' end,
    error_code='lease_expired',finished_at=clock_timestamp()
    where client_id=p_client_id and user_id=p_user_id and status in ('preparing','dispatching') and expires_at<=clock_timestamp();
  delete from public.outreach_lead_alert_items i using public.outreach_lead_alert_deliveries d
    where i.delivery_id=d.id and d.client_id=p_client_id and d.user_id=p_user_id and d.status in ('cancelled','failed');
end; $$;
revoke all on function outreach_private.expire_lead_alerts(uuid,uuid) from public,anon,authenticated,service_role;

create function outreach_private.lead_alert_payload(p_row public.outreach_lead_alert_deliveries) returns jsonb
language sql immutable set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('id',p_row.id,'claimToken',p_row.claim_token,'clientId',p_row.client_id,
    'userId',p_row.user_id,'recipientEmail',p_row.recipient_email,'leadCount',p_row.lead_count,'expiresAt',p_row.expires_at);
$$;
revoke all on function outreach_private.lead_alert_payload(public.outreach_lead_alert_deliveries) from public,anon,authenticated,service_role;

create function public.claim_outreach_lead_alert(p_client_id uuid,p_user_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare policy public.outreach_lead_alert_policies%rowtype; delivery public.outreach_lead_alert_deliveries%rowtype;
  recipient record; items jsonb; item_count integer;
begin
  perform outreach_private.lock_lead_alert_scope(p_client_id,p_user_id);
  select * into policy from public.outreach_lead_alert_policies where client_id=p_client_id and user_id=p_user_id for update;
  perform outreach_private.expire_lead_alerts(p_client_id,p_user_id);
  if policy.client_id is null or not policy.enabled then return null; end if;
  select * into recipient from outreach_private.lead_alert_recipient(p_client_id,p_user_id);
  if not found then return null; end if;
  if exists(select 1 from public.outreach_lead_alert_deliveries d where d.client_id=p_client_id and d.user_id=p_user_id
    and (d.status in ('preparing','dispatching','unknown')
      or (d.status='failed' and d.policy_version=policy.version and d.policy_enabled_at=policy.enabled_at)
      or (d.status='sent' and d.finished_at>clock_timestamp()-make_interval(hours=>policy.cooldown_hours)))) then return null; end if;
  select coalesce(jsonb_agg(to_jsonb(e)),'[]'::jsonb),count(*)::integer into items,item_count
    from outreach_private.eligible_lead_alert_items(p_client_id,p_user_id,policy.enabled_at) e;
  if item_count<policy.threshold then return null; end if;
  insert into public.outreach_lead_alert_deliveries(client_id,user_id,recipient_email,policy_version,policy_enabled_at,membership_version,threshold,lead_count)
    values(p_client_id,p_user_id,recipient.email,policy.version,policy.enabled_at,recipient.membership_version,policy.threshold,item_count)
    returning * into delivery;
  insert into public.outreach_lead_alert_items(delivery_id,client_id,user_id,contact_key,conversation_id,latest_message_id)
    select delivery.id,p_client_id,p_user_id,e.contact_key,e.conversation_id,e.latest_message_id
    from jsonb_to_recordset(items) as e(contact_key text,conversation_id uuid,latest_message_id uuid);
  return outreach_private.lead_alert_payload(delivery);
end; $$;
revoke all on function public.claim_outreach_lead_alert(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_outreach_lead_alert(uuid,uuid) to service_role;

create function public.dispatch_outreach_lead_alert(p_delivery_id uuid,p_claim_token uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare delivery public.outreach_lead_alert_deliveries%rowtype; policy public.outreach_lead_alert_policies%rowtype;
  recipient record; items jsonb; item_count integer;
begin
  select * into delivery from public.outreach_lead_alert_deliveries where id=p_delivery_id;
  if not found then return null; end if;
  perform outreach_private.lock_lead_alert_scope(delivery.client_id,delivery.user_id);
  select * into policy from public.outreach_lead_alert_policies where client_id=delivery.client_id and user_id=delivery.user_id for update;
  perform outreach_private.expire_lead_alerts(delivery.client_id,delivery.user_id);
  select * into delivery from public.outreach_lead_alert_deliveries where id=p_delivery_id for update;
  if not found or delivery.status<>'preparing' or delivery.claim_token is distinct from p_claim_token or delivery.expires_at<=clock_timestamp() then return null; end if;
  select * into recipient from outreach_private.lead_alert_recipient(delivery.client_id,delivery.user_id);
  if not found or policy.client_id is null or not policy.enabled or policy.version<>delivery.policy_version
    or policy.enabled_at is distinct from delivery.policy_enabled_at
    or recipient.email is distinct from delivery.recipient_email or recipient.membership_version is distinct from delivery.membership_version then
    update public.outreach_lead_alert_deliveries set status='cancelled',error_code='context_changed',finished_at=clock_timestamp() where id=delivery.id;
    delete from public.outreach_lead_alert_items where delivery_id=delivery.id;
    return null;
  end if;
  select coalesce(jsonb_agg(to_jsonb(e)),'[]'::jsonb),count(*)::integer into items,item_count
    from outreach_private.eligible_lead_alert_items(delivery.client_id,delivery.user_id,policy.enabled_at,delivery.id) e;
  if item_count<policy.threshold then
    update public.outreach_lead_alert_deliveries set status='cancelled',error_code='context_changed',lead_count=item_count,finished_at=clock_timestamp() where id=delivery.id;
    delete from public.outreach_lead_alert_items where delivery_id=delivery.id;
    return null;
  end if;
  -- Refresh the snapshot atomically. The worker gets the current count only
  -- after this final eligibility/recipient check has authorized one dispatch.
  delete from public.outreach_lead_alert_items where delivery_id=delivery.id;
  insert into public.outreach_lead_alert_items(delivery_id,client_id,user_id,contact_key,conversation_id,latest_message_id)
    select delivery.id,delivery.client_id,delivery.user_id,e.contact_key,e.conversation_id,e.latest_message_id
    from jsonb_to_recordset(items) as e(contact_key text,conversation_id uuid,latest_message_id uuid);
  -- All authority locks may have waited. Evaluate the lease using wall time
  -- immediately before consuming it, never the transaction's starting time.
  if delivery.expires_at<=clock_timestamp() then
    update public.outreach_lead_alert_deliveries set status='cancelled',error_code='lease_expired',finished_at=clock_timestamp() where id=delivery.id;
    delete from public.outreach_lead_alert_items where delivery_id=delivery.id;
    return null;
  end if;
  update public.outreach_lead_alert_deliveries set status='dispatching',lead_count=item_count,dispatched_at=clock_timestamp(),
    expires_at=clock_timestamp()+interval '60 seconds' where id=delivery.id returning * into delivery;
  return outreach_private.lead_alert_payload(delivery);
end; $$;
revoke all on function public.dispatch_outreach_lead_alert(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.dispatch_outreach_lead_alert(uuid,uuid) to service_role;

create function public.finish_outreach_lead_alert(p_delivery_id uuid,p_claim_token uuid,p_status text,p_error_code text default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare delivery public.outreach_lead_alert_deliveries%rowtype;
begin
  if p_status is null or p_status not in ('sent','failed','unknown') or (p_error_code is not null and p_error_code !~ '^[a-z0-9_]{1,64}$') then
    raise exception using errcode='22023',message='Invalid alert outcome';
  end if;
  select * into delivery from public.outreach_lead_alert_deliveries where id=p_delivery_id;
  if not found then return false; end if;
  -- Receipt finalization takes no message FK locks, so the tenant fence alone
  -- is enough; it never changes authorization or dispatches a new message.
  perform 1 from public.clients where id=delivery.client_id for no key update;
  select * into delivery from public.outreach_lead_alert_deliveries where id=p_delivery_id for update;
  if not found or delivery.claim_token is distinct from p_claim_token then return false; end if;
  if delivery.status='dispatching' and delivery.expires_at<=clock_timestamp() then
    update public.outreach_lead_alert_deliveries set status='unknown',error_code='lease_expired',finished_at=clock_timestamp()
      where id=delivery.id returning * into delivery;
  end if;
  if delivery.status=p_status then return true; end if;
  if delivery.status='sent' or delivery.status='cancelled' or delivery.status='failed' then return false; end if;
  if delivery.status='unknown' and p_status<>'sent' then return false; end if;
  if delivery.status='preparing' and p_status<>'failed' then return false; end if;
  update public.outreach_lead_alert_deliveries set status=p_status,error_code=p_error_code,finished_at=clock_timestamp() where id=delivery.id;
  if p_status='failed' then delete from public.outreach_lead_alert_items where delivery_id=delivery.id; end if;
  return true;
end; $$;
revoke all on function public.finish_outreach_lead_alert(uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_outreach_lead_alert(uuid,uuid,text,text) to service_role;

-- A confirmed failure blocks its policy version indefinitely. Do not hide
-- that operational state behind a recent-activity window or count a failure
-- again after the owner has explicitly reconfigured its recipient policy.
create function public.outreach_lead_alert_delivery_health() returns jsonb
language sql security definer set search_path=pg_catalog,public,pg_temp as $$
  select jsonb_build_object(
    'unknown',(select count(*) from public.outreach_lead_alert_deliveries where status='unknown'),
    'expiredDispatches',(select count(*) from public.outreach_lead_alert_deliveries
      where status='dispatching' and expires_at<=clock_timestamp()),
    'blockedFailures',(select count(*) from public.outreach_lead_alert_deliveries d
      join public.outreach_lead_alert_policies p on p.client_id=d.client_id and p.user_id=d.user_id
        and p.enabled and p.version=d.policy_version and p.enabled_at=d.policy_enabled_at
      where d.status='failed')
  );
$$;
revoke all on function public.outreach_lead_alert_delivery_health() from public,anon,authenticated,service_role;
grant execute on function public.outreach_lead_alert_delivery_health() to service_role;
