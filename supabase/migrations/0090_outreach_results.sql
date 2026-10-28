-- Extracted for the independent outbound platform; see docs/schema-extraction.md.
-- Covora Outreach: service-owned mirrors and authenticated neutral projections.
-- An invoker view cannot read a denied table directly. Its private, guarded
-- definer projection is the only read bridge; no provider fields cross it.
create schema if not exists outreach_private;
revoke all on schema outreach_private from public, anon, authenticated;

create table public.outreach_campaigns (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  provider_campaign_id text not null unique,
  name text not null check (length(name) between 1 and 500),
  status text not null default 'draft',
  schedule jsonb not null default '{}'::jsonb,
  totals jsonb not null default '{}'::jsonb,
  synced_at timestamptz,
  completed_at timestamptz,
  messages_purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id, client_id)
);
create index outreach_campaigns_client_idx on public.outreach_campaigns(client_id, created_at desc);
create trigger outreach_campaigns_updated before update on public.outreach_campaigns
  for each row execute function public.set_updated_at();

create table public.outreach_campaign_steps (
  campaign_id uuid not null,
  client_id uuid not null,
  step integer not null check(step >= 0),
  variant integer not null default 0 check(variant >= 0),
  subject text not null default '',
  body_text text not null default '',
  delay_days numeric not null default 0 check(delay_days >= 0),
  stats jsonb not null default '{}'::jsonb,
  primary key(campaign_id, step, variant),
  foreign key(campaign_id, client_id) references public.outreach_campaigns(id, client_id) on delete cascade
);
create table public.outreach_campaign_daily (
  campaign_id uuid not null,
  client_id uuid not null,
  day date not null,
  sent bigint not null default 0 check(sent >= 0),
  contacted bigint not null default 0 check(contacted >= 0),
  new_contacted bigint not null default 0 check(new_contacted >= 0),
  unique_opened bigint not null default 0 check(unique_opened >= 0),
  unique_replies bigint not null default 0 check(unique_replies >= 0),
  auto_replies bigint not null default 0 check(auto_replies >= 0),
  unique_clicks bigint not null default 0 check(unique_clicks >= 0),
  opportunities bigint not null default 0 check(opportunities >= 0),
  primary key(campaign_id, day),
  foreign key(campaign_id, client_id) references public.outreach_campaigns(id, client_id) on delete cascade
);
create table public.outreach_leads (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,
  client_id uuid not null,
  provider_lead_id text,
  email text not null,
  first_name text,
  last_name text,
  company text,
  status text not null default 'not_contacted',
  last_step integer,
  reply_count integer not null default 0 check(reply_count >= 0),
  interest text,
  last_activity_at timestamptz,
  unique(campaign_id, email),
  foreign key(campaign_id, client_id) references public.outreach_campaigns(id, client_id) on delete cascade
);
create table public.outreach_messages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,
  client_id uuid not null,
  provider_email_id text not null unique,
  provider_thread_id text,
  provider_account text,
  thread_key uuid not null,
  direction text not null check(direction in ('sent', 'received')),
  lead_email text,
  from_email text not null default '',
  to_email text not null default '',
  subject text not null default '',
  body_text text not null default '',
  sent_at timestamptz not null,
  interest text,
  is_auto_reply boolean not null default false,
  client_read_at timestamptz,
  foreign key(campaign_id, client_id) references public.outreach_campaigns(id, client_id) on delete cascade
);
create index outreach_messages_client_sent_idx on public.outreach_messages(client_id,sent_at desc);
create index outreach_messages_thread_idx on public.outreach_messages(campaign_id,thread_key,sent_at);
create table public.outreach_sync_state (
  campaign_id uuid primary key,
  client_id uuid not null,
  last_served_at timestamptz,
  last_email_kind text not null default 'queue',
  meta_synced_at timestamptz,
  daily_synced_at timestamptz,
  leads_synced_at timestamptz,
  replies_synced_at timestamptz,
  lead_cursor text,
  reply_cursor text,
  reply_watermark text,
  reply_scan_started_at timestamptz,
  retry_after timestamptz,
  attempt_count integer not null default 0 check(attempt_count >= 0),
  last_error text,
  foreign key(campaign_id, client_id) references public.outreach_campaigns(id, client_id) on delete cascade
);
create table public.outreach_fetch_queue (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,
  client_id uuid not null,
  lead_email text not null default '',
  provider_thread_id text not null default '',
  cursor text,
  available_at timestamptz not null default now(),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  attempt_count integer not null default 0 check(attempt_count >= 0),
  last_error text,
  unique(campaign_id, lead_email, provider_thread_id),
  foreign key(campaign_id, client_id) references public.outreach_campaigns(id, client_id) on delete cascade,
  check(lead_email <> '' or provider_thread_id <> '')
);
create index outreach_fetch_queue_ready_idx on public.outreach_fetch_queue(available_at) where completed_at is null;
create table public.outreach_worker_state (
  singleton boolean primary key default true check(singleton),
  lease_token uuid,
  lease_expires_at timestamptz,
  email_request_times timestamptz[] not null default '{}'
);
insert into public.outreach_worker_state(singleton) values(true);

alter table public.outreach_campaigns enable row level security;
create policy outreach_campaigns_service on public.outreach_campaigns for all to service_role using(true) with check(true);
revoke all on table public.outreach_campaigns from public, anon, authenticated;
grant all on table public.outreach_campaigns to service_role;

alter table public.outreach_campaign_steps enable row level security;
create policy outreach_campaign_steps_service on public.outreach_campaign_steps for all to service_role using(true) with check(true);
revoke all on table public.outreach_campaign_steps from public, anon, authenticated;
grant all on table public.outreach_campaign_steps to service_role;

alter table public.outreach_campaign_daily enable row level security;
create policy outreach_campaign_daily_service on public.outreach_campaign_daily for all to service_role using(true) with check(true);
revoke all on table public.outreach_campaign_daily from public, anon, authenticated;
grant all on table public.outreach_campaign_daily to service_role;

alter table public.outreach_leads enable row level security;
create policy outreach_leads_service on public.outreach_leads for all to service_role using(true) with check(true);
revoke all on table public.outreach_leads from public, anon, authenticated;
grant all on table public.outreach_leads to service_role;

alter table public.outreach_messages enable row level security;
create policy outreach_messages_service on public.outreach_messages for all to service_role using(true) with check(true);
revoke all on table public.outreach_messages from public, anon, authenticated;
grant all on table public.outreach_messages to service_role;

alter table public.outreach_sync_state enable row level security;
create policy outreach_sync_state_service on public.outreach_sync_state for all to service_role using(true) with check(true);
revoke all on table public.outreach_sync_state from public, anon, authenticated;
grant all on table public.outreach_sync_state to service_role;

alter table public.outreach_fetch_queue enable row level security;
create policy outreach_fetch_queue_service on public.outreach_fetch_queue for all to service_role using(true) with check(true);
revoke all on table public.outreach_fetch_queue from public, anon, authenticated;
grant all on table public.outreach_fetch_queue to service_role;

alter table public.outreach_worker_state enable row level security;
create policy outreach_worker_state_service on public.outreach_worker_state for all to service_role using(true) with check(true);
revoke all on table public.outreach_worker_state from public, anon, authenticated;
grant all on table public.outreach_worker_state to service_role;

-- Assignment identity cannot change under existing cached rows or an active
-- worker. Unassign deletes the mirror; assigning again gets a fresh UUID.
create function outreach_private.guard_assignment() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.client_id is distinct from old.client_id or new.provider_campaign_id is distinct from old.provider_campaign_id then
    raise exception 'Unassign the campaign before changing ownership';
  end if;
  if old.messages_purged_at is not null and new.messages_purged_at is distinct from old.messages_purged_at then
    raise exception 'Message retention cannot be reversed';
  end if;
  return new;
end;
$$;
revoke all on function outreach_private.guard_assignment() from public, anon, authenticated, service_role;
create trigger outreach_assignment_identity before update on public.outreach_campaigns
for each row execute function outreach_private.guard_assignment();

create function outreach_private.can_read(p_client_id uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select false; -- Fail closed until explicit product membership helpers are installed.
$$;
revoke all on function outreach_private.can_read(uuid) from public, anon, authenticated, service_role;

-- JSON mirrors are projected by allowlist too: omitting provider_* columns
-- alone would still allow a nested vendor id to escape through raw JSON.
create function outreach_private.metrics(p_data jsonb, p_keys text[]) returns jsonb
language sql immutable set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(jsonb_object_agg(k,v), '{}'::jsonb)
  from jsonb_each(case when jsonb_typeof(p_data) = 'object' then p_data else '{}'::jsonb end) x(k,v)
  where k = any(p_keys) and jsonb_typeof(v) = 'number';
$$;
revoke all on function outreach_private.metrics(jsonb,text[]) from public, anon, authenticated, service_role;
create function outreach_private.schedule(p_data jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object(
    'start_date', p_data->>'start_date', 'end_date', p_data->>'end_date',
    'windows', coalesce((select jsonb_agg(jsonb_build_object(
      'timezone', w->>'timezone', 'from', w->>'from', 'to', w->>'to',
      'days', coalesce((select jsonb_agg(d) from jsonb_array_elements(
        case when jsonb_typeof(w->'days') = 'array' then w->'days' else '[]'::jsonb end) d
        where jsonb_typeof(d) = 'number'), '[]'::jsonb)
    )) from jsonb_array_elements(case when jsonb_typeof(p_data->'windows') = 'array'
      then p_data->'windows' else '[]'::jsonb end) w), '[]'::jsonb)
  );
$$;
revoke all on function outreach_private.schedule(jsonb) from public, anon, authenticated, service_role;

create function outreach_private.read_campaigns() returns table(id uuid,client_id uuid,name text,status text,schedule jsonb,totals jsonb,synced_at timestamptz,completed_at timestamptz,created_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select c.id,c.client_id,c.name,c.status,outreach_private.schedule(c.schedule),outreach_private.metrics(c.totals,array['leads','contacted','sent','unique_opened','unique_replies','unique_auto_replies','bounced','unsubscribed','completed','opportunities','positive_replies','unique_clicks']),c.synced_at,c.completed_at,c.created_at from public.outreach_campaigns c where outreach_private.can_read(c.client_id);
$$;
revoke all on function outreach_private.read_campaigns() from public, anon, authenticated, service_role;
grant execute on function outreach_private.read_campaigns() to authenticated;
create view public.client_outreach_campaigns with(security_invoker = true, security_barrier = true) as
  select * from outreach_private.read_campaigns();
revoke all on table public.client_outreach_campaigns from public, anon, authenticated;
grant select on table public.client_outreach_campaigns to authenticated;

create function outreach_private.read_campaign_steps() returns table(campaign_id uuid,client_id uuid,step integer,variant integer,subject text,body_text text,delay_days numeric,stats jsonb)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select c.campaign_id,c.client_id,c.step,c.variant,c.subject,c.body_text,c.delay_days,outreach_private.metrics(c.stats,array['sent','contacted','unique_opened','unique_replies','unique_auto_replies','unique_clicks','opportunities']) from public.outreach_campaign_steps c where outreach_private.can_read(c.client_id);
$$;
revoke all on function outreach_private.read_campaign_steps() from public, anon, authenticated, service_role;
grant execute on function outreach_private.read_campaign_steps() to authenticated;
create view public.client_outreach_campaign_steps with(security_invoker = true, security_barrier = true) as
  select * from outreach_private.read_campaign_steps();
revoke all on table public.client_outreach_campaign_steps from public, anon, authenticated;
grant select on table public.client_outreach_campaign_steps to authenticated;

create function outreach_private.read_campaign_daily() returns table(campaign_id uuid,client_id uuid,day date,sent bigint,contacted bigint,new_contacted bigint,unique_opened bigint,unique_replies bigint,auto_replies bigint,unique_clicks bigint,opportunities bigint)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select c.campaign_id,c.client_id,c.day,c.sent,c.contacted,c.new_contacted,c.unique_opened,c.unique_replies,c.auto_replies,c.unique_clicks,c.opportunities from public.outreach_campaign_daily c where outreach_private.can_read(c.client_id);
$$;
revoke all on function outreach_private.read_campaign_daily() from public, anon, authenticated, service_role;
grant execute on function outreach_private.read_campaign_daily() to authenticated;
create view public.client_outreach_campaign_daily with(security_invoker = true, security_barrier = true) as
  select * from outreach_private.read_campaign_daily();
revoke all on table public.client_outreach_campaign_daily from public, anon, authenticated;
grant select on table public.client_outreach_campaign_daily to authenticated;

create function outreach_private.read_leads() returns table(id uuid,campaign_id uuid,client_id uuid,email text,first_name text,last_name text,company text,status text,last_step integer,reply_count integer,interest text,last_activity_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select c.id,c.campaign_id,c.client_id,c.email,c.first_name,c.last_name,c.company,c.status,c.last_step,c.reply_count,c.interest,c.last_activity_at from public.outreach_leads c where outreach_private.can_read(c.client_id);
$$;
revoke all on function outreach_private.read_leads() from public, anon, authenticated, service_role;
grant execute on function outreach_private.read_leads() to authenticated;
create view public.client_outreach_leads with(security_invoker = true, security_barrier = true) as
  select * from outreach_private.read_leads();
revoke all on table public.client_outreach_leads from public, anon, authenticated;
grant select on table public.client_outreach_leads to authenticated;

create function outreach_private.read_messages() returns table(id uuid,campaign_id uuid,client_id uuid,thread_key uuid,direction text,lead_email text,from_email text,to_email text,subject text,body_text text,sent_at timestamptz,interest text,is_auto_reply boolean,client_read_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select c.id,c.campaign_id,c.client_id,c.thread_key,c.direction,c.lead_email,c.from_email,c.to_email,c.subject,c.body_text,c.sent_at,c.interest,c.is_auto_reply,c.client_read_at from public.outreach_messages c where outreach_private.can_read(c.client_id);
$$;
revoke all on function outreach_private.read_messages() from public, anon, authenticated, service_role;
grant execute on function outreach_private.read_messages() to authenticated;
create view public.client_outreach_messages with(security_invoker = true, security_barrier = true) as
  select * from outreach_private.read_messages();
revoke all on table public.client_outreach_messages from public, anon, authenticated;
grant select on table public.client_outreach_messages to authenticated;

create function outreach_private.initialize_sync_state() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  insert into public.outreach_sync_state(campaign_id,client_id) values(new.id,new.client_id);
  return new;
end;
$$;
revoke all on function outreach_private.initialize_sync_state() from public, anon, authenticated, service_role;
create trigger outreach_campaign_sync_state after insert on public.outreach_campaigns
for each row execute function outreach_private.initialize_sync_state();

create function public.mark_outreach_messages_read(ids uuid[]) returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare expected integer; matched integer; changed integer;
begin
  if auth.uid() is null or ids is null or cardinality(ids) > 1000 or array_position(ids,null) is not null then
    raise exception 'Message access denied';
  end if;
  select count(distinct x) into expected from unnest(ids) x;
  -- Lock the entire requested set before checking it, so a mixed-tenant call
  -- cannot partially succeed and deletion cannot race authorization.
  perform 1 from public.outreach_messages where id = any(ids) for update;
  select count(*) into matched from public.outreach_messages m
    where m.id = any(ids) and outreach_private.can_read(m.client_id);
  if matched <> expected then raise exception 'Message access denied'; end if;
  update public.outreach_messages set client_read_at = now()
    where id = any(ids) and client_read_at is null;
  get diagnostics changed = row_count;
  return changed;
end;
$$;
revoke all on function public.mark_outreach_messages_read(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.mark_outreach_messages_read(uuid[]) to authenticated;

create function public.acquire_outreach_sync_lock(p_token uuid,p_seconds integer default 120) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if p_token is null or p_seconds < 1 or p_seconds > 300 then raise exception 'Invalid sync lease'; end if;
  update public.outreach_worker_state
    set lease_token = p_token, lease_expires_at = clock_timestamp() + make_interval(secs => p_seconds)
    where singleton and (lease_expires_at is null or lease_expires_at <= clock_timestamp() or lease_token = p_token);
  return found;
end;
$$;
revoke all on function public.acquire_outreach_sync_lock(uuid,integer) from public, anon, authenticated, service_role;
grant execute on function public.acquire_outreach_sync_lock(uuid,integer) to service_role;
create function public.release_outreach_sync_lock(p_token uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  update public.outreach_worker_state set lease_token = null,lease_expires_at = null
    where singleton and lease_token = p_token;
  return found;
end;
$$;
revoke all on function public.release_outreach_sync_lock(uuid) from public, anon, authenticated, service_role;
grant execute on function public.release_outreach_sync_lock(uuid) to service_role;

create function public.reserve_outreach_email_request(p_token uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare state public.outreach_worker_state%rowtype; recent timestamptz[]; moment timestamptz;
begin
  select * into state from public.outreach_worker_state where singleton for update;
  moment := clock_timestamp();
  if state.lease_token is distinct from p_token or p_token is null or state.lease_expires_at <= moment then return false; end if;
  select coalesce(array_agg(t),'{}'::timestamptz[]) into recent
    from unnest(state.email_request_times) t where t > moment - interval '60 seconds';
  if cardinality(recent) >= 10 then return false; end if;
  update public.outreach_worker_state set email_request_times = array_append(recent,moment) where singleton;
  return true;
end;
$$;
revoke all on function public.reserve_outreach_email_request(uuid) from public, anon, authenticated, service_role;
grant execute on function public.reserve_outreach_email_request(uuid) to service_role;

create function public.enqueue_outreach_fetch(p_provider_campaign_id text,p_lead_email text) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare assignment public.outreach_campaigns%rowtype;
begin
  if p_lead_email is null or length(trim(p_lead_email)) = 0 or length(p_lead_email) > 320 then return false; end if;
  select * into assignment from public.outreach_campaigns
    where provider_campaign_id = p_provider_campaign_id and messages_purged_at is null for share;
  if not found then return false; end if;
  insert into public.outreach_fetch_queue(campaign_id,client_id,lead_email)
    values(assignment.id,assignment.client_id,lower(trim(p_lead_email)))
    on conflict(campaign_id,lead_email,provider_thread_id) do update set
      requested_at = clock_timestamp(),available_at = clock_timestamp(),completed_at = null,cursor = null,
      attempt_count = 0,last_error = null;
  return true;
end;
$$;
revoke all on function public.enqueue_outreach_fetch(text,text) from public, anon, authenticated, service_role;
grant execute on function public.enqueue_outreach_fetch(text,text) to service_role;

create function public.purge_outreach_messages(p_campaign_id uuid,p_token uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  -- Hold the lease row while purging, so a second worker cannot acquire it
  -- between the expiry check and the deletes.
  perform 1 from public.outreach_worker_state where singleton and lease_token = p_token
    and lease_expires_at > clock_timestamp() for update;
  if not found then return false; end if;
  perform 1 from public.outreach_campaigns where id = p_campaign_id
    and completed_at <= clock_timestamp() - interval '180 days' and messages_purged_at is null for update;
  if not found then return false; end if;
  delete from public.outreach_messages where campaign_id = p_campaign_id;
  delete from public.outreach_fetch_queue where campaign_id = p_campaign_id;
  update public.outreach_campaigns set messages_purged_at = clock_timestamp() where id = p_campaign_id;
  return true;
end;
$$;
revoke all on function public.purge_outreach_messages(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.purge_outreach_messages(uuid,uuid) to service_role;
-- A delayed API response must not recreate purged message text or requeue
-- its fetch. SHARE blocks the purge's campaign UPDATE lock until the insert
-- finishes; the purge then deletes it. A later insert sees the permanent flag.
create function outreach_private.guard_retained_insert() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform 1 from public.outreach_campaigns where id = new.campaign_id
    and client_id = new.client_id and messages_purged_at is null for share;
  if not found then raise exception 'Message retention or assignment disallows this write'; end if;
  return new;
end;
$$;
revoke all on function outreach_private.guard_retained_insert() from public, anon, authenticated, service_role;
create trigger outreach_messages_retention before insert on public.outreach_messages
for each row execute function outreach_private.guard_retained_insert();
create trigger outreach_fetch_retention before insert on public.outreach_fetch_queue
for each row execute function outreach_private.guard_retained_insert();

-- A provider-wide email id is an upsert key, never permission to move a
-- cached message between assigned campaigns if a provider response is wrong.
create function outreach_private.guard_message_identity() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.campaign_id is distinct from old.campaign_id or new.client_id is distinct from old.client_id
    or new.provider_email_id is distinct from old.provider_email_id then
    raise exception 'Message ownership cannot change';
  end if;
  return new;
end;
$$;
revoke all on function outreach_private.guard_message_identity() from public, anon, authenticated, service_role;
create trigger outreach_message_identity before update on public.outreach_messages
for each row execute function outreach_private.guard_message_identity();
notify pgrst, 'reload schema';
