-- Extracted for the independent outbound platform; see docs/schema-extraction.md.
-- Outbound is a separate product: existing Auth identities do not imply
-- entitlement, and legacy administrator profiles confer no Outbound access.
create table public.outreach_agency_memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role = 'owner'),
  state text not null default 'active' check (state in ('active', 'suspended', 'revoked')),
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.outreach_agency_memberships enable row level security;
create policy outreach_agency_memberships_service on public.outreach_agency_memberships
  for all to service_role using (true) with check (true);
revoke all on table public.outreach_agency_memberships from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.outreach_agency_memberships to service_role;

create table public.outreach_memberships (
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  role text not null check (role in ('client_admin', 'client_member', 'client_viewer', 'operator')),
  state text not null default 'active' check (state in ('active', 'suspended', 'revoked')),
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, client_id)
);
create index outreach_memberships_client_idx on public.outreach_memberships(client_id, state);
alter table public.outreach_memberships enable row level security;
create policy outreach_memberships_service on public.outreach_memberships
  for all to service_role using (true) with check (true);
revoke all on table public.outreach_memberships from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.outreach_memberships to service_role;

create function outreach_private.version_membership() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
  else
    if new.user_id is distinct from old.user_id
      or (to_jsonb(new)->'client_id') is distinct from (to_jsonb(old)->'client_id') then
      raise exception using errcode = '22023', message = 'Membership identity cannot change';
    end if;
    new.version := old.version + 1;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function outreach_private.version_membership() from public, anon, authenticated, service_role;
create trigger outreach_agency_membership_version before insert or update on public.outreach_agency_memberships
  for each row execute function outreach_private.version_membership();
create trigger outreach_membership_version before insert or update on public.outreach_memberships
  for each row execute function outreach_private.version_membership();

-- This helper accepts no actor argument: auth.uid() is the only identity.
-- Even an explicit owner grant cannot bypass a workspace's feature gate.
create function outreach_private.workspace_role(p_client_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select case when auth.uid() is not null and exists (
    select 1 from public.client_features f
    where f.client_id = p_client_id and f.feature = 'outreach_app' and f.enabled
  ) then coalesce(
    (select 'agency_owner'::text from public.outreach_agency_memberships a
      where a.user_id = auth.uid() and a.state = 'active'),
    (select m.role from public.outreach_memberships m
      where m.user_id = auth.uid() and m.client_id = p_client_id and m.state = 'active')
  ) else null end;
$$;
revoke all on function outreach_private.workspace_role(uuid) from public, anon, authenticated, service_role;

create or replace function outreach_private.can_read(p_client_id uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select outreach_private.workspace_role(p_client_id) is not null;
$$;
revoke all on function outreach_private.can_read(uuid) from public, anon, authenticated, service_role;

create function outreach_private.read_workspaces()
returns table(client_id uuid, client_name text, role text)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select c.id, c.name, outreach_private.workspace_role(c.id)
  from public.clients c where outreach_private.can_read(c.id);
$$;
revoke all on function outreach_private.read_workspaces() from public, anon, authenticated, service_role;
grant execute on function outreach_private.read_workspaces() to authenticated;
create view public.client_outreach_workspaces with (security_invoker = true, security_barrier = true)
  as select * from outreach_private.read_workspaces();
revoke all on table public.client_outreach_workspaces from public, anon, authenticated, service_role;
grant select on table public.client_outreach_workspaces to authenticated;

create table public.outreach_setup_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  requested_by uuid not null references auth.users(id),
  channel text not null check (channel in ('email', 'linkedin')),
  method text not null check (method in ('google_workspace', 'microsoft', 'assisted')),
  status text not null default 'requested' check (status in ('requested', 'in_progress', 'needs_action', 'resolved')),
  note text not null default '' check (length(note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (channel <> 'linkedin' or method = 'assisted')
);
create unique index outreach_setup_request_open_idx
  on public.outreach_setup_requests(client_id, channel, method) where status <> 'resolved';
create index outreach_setup_requests_client_idx on public.outreach_setup_requests(client_id, created_at desc, id);
alter table public.outreach_setup_requests enable row level security;
create policy outreach_setup_requests_service on public.outreach_setup_requests
  for all to service_role using (true) with check (true);
revoke all on table public.outreach_setup_requests from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.outreach_setup_requests to service_role;

-- No cascading FK: removing an auth identity or workspace must not erase the
-- immutable actor/workspace identifiers needed to explain a prior command.
create table public.outreach_access_audit (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  actor_user_id uuid not null,
  subject_id uuid not null,
  event_type text not null check (event_type in ('setup_requested', 'setup_updated')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index outreach_access_audit_subject_idx on public.outreach_access_audit(subject_id, created_at, id);
create index outreach_access_audit_client_idx on public.outreach_access_audit(client_id, created_at desc);
alter table public.outreach_access_audit enable row level security;
create policy outreach_access_audit_service_read on public.outreach_access_audit
  for select to service_role using (true);
create policy outreach_access_audit_service_insert on public.outreach_access_audit
  for insert to service_role with check (true);
revoke all on table public.outreach_access_audit from public, anon, authenticated, service_role;
grant select, insert on table public.outreach_access_audit to service_role;

create function outreach_private.guard_access_audit() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  raise exception using errcode = '55000', message = 'Access audit is immutable';
end;
$$;
revoke all on function outreach_private.guard_access_audit() from public, anon, authenticated, service_role;
create trigger outreach_access_audit_immutable before update or delete on public.outreach_access_audit
  for each row execute function outreach_private.guard_access_audit();

create function outreach_private.guard_setup_request() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.id is distinct from old.id or new.client_id is distinct from old.client_id
    or new.requested_by is distinct from old.requested_by or new.channel is distinct from old.channel
    or new.method is distinct from old.method or new.created_at is distinct from old.created_at then
    raise exception using errcode = '22023', message = 'Setup request identity cannot change';
  end if;
  if (old.status = 'resolved' and new.status <> 'resolved')
    or (old.status <> 'requested' and new.status = 'requested') then
    raise exception using errcode = '22023', message = 'Invalid setup request transition';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function outreach_private.guard_setup_request() from public, anon, authenticated, service_role;
create trigger outreach_setup_request_integrity before update on public.outreach_setup_requests
  for each row execute function outreach_private.guard_setup_request();

create function outreach_private.read_setup_requests()
returns table(id uuid, client_id uuid, channel text, method text, status text, note text, created_at timestamptz, updated_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select r.id, r.client_id, r.channel, r.method, r.status, r.note, r.created_at, r.updated_at
  from public.outreach_setup_requests r where outreach_private.can_read(r.client_id);
$$;
revoke all on function outreach_private.read_setup_requests() from public, anon, authenticated, service_role;
grant execute on function outreach_private.read_setup_requests() to authenticated;
create view public.client_outreach_setup_requests with (security_invoker = true, security_barrier = true)
  as select * from outreach_private.read_setup_requests();
revoke all on table public.client_outreach_setup_requests from public, anon, authenticated, service_role;
grant select on table public.client_outreach_setup_requests to authenticated;

create function public.request_outreach_setup(p_client_id uuid, p_channel text, p_method text) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare request_id uuid; effective_role text;
begin
  effective_role := outreach_private.workspace_role(p_client_id);
  if effective_role is null or effective_role not in ('client_admin', 'operator', 'agency_owner') then
    raise exception using errcode = '42501', message = 'Setup access denied';
  end if;
  if p_channel is null or p_channel not in ('email', 'linkedin') or p_method is null
    or p_method not in ('google_workspace', 'microsoft', 'assisted')
    or (p_channel = 'linkedin' and p_method <> 'assisted') then
    raise exception using errcode = '22023', message = 'Invalid setup request';
  end if;
  -- A conflict can be concurrently resolved before it becomes visible to
  -- this transaction. Retry the insert only when no open row remains.
  loop
    insert into public.outreach_setup_requests(client_id, requested_by, channel, method)
    values (p_client_id, auth.uid(), p_channel, p_method)
    on conflict (client_id, channel, method) where status <> 'resolved' do nothing
    returning id into request_id;
    if request_id is not null then
      insert into public.outreach_access_audit(client_id, actor_user_id, subject_id, event_type, details)
      values (p_client_id, auth.uid(), request_id, 'setup_requested', jsonb_build_object('channel', p_channel, 'method', p_method));
      return request_id;
    end if;
    select r.id into request_id from public.outreach_setup_requests r
      where r.client_id = p_client_id and r.channel = p_channel and r.method = p_method and r.status <> 'resolved'
      for update;
    if request_id is not null then return request_id; end if;
  end loop;
end;
$$;
revoke all on function public.request_outreach_setup(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.request_outreach_setup(uuid, text, text) to authenticated;

create function public.update_outreach_setup_request(p_request_id uuid, p_status text, p_note text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare request_row public.outreach_setup_requests%rowtype; effective_role text;
begin
  select r.* into request_row from public.outreach_setup_requests r
    where r.id = p_request_id and outreach_private.can_read(r.client_id) for update;
  if not found then raise exception using errcode = '42501', message = 'Setup access denied'; end if;
  effective_role := outreach_private.workspace_role(request_row.client_id);
  if effective_role is null or effective_role not in ('operator', 'agency_owner') then
    raise exception using errcode = '42501', message = 'Setup access denied';
  end if;
  if p_status is null or p_status not in ('requested', 'in_progress', 'needs_action', 'resolved')
    or p_note is null or length(p_note) > 1000 then
    raise exception using errcode = '22023', message = 'Invalid setup update';
  end if;
  if request_row.status = p_status and request_row.note = p_note then return; end if;
  update public.outreach_setup_requests set status = p_status, note = p_note where id = request_row.id;
  -- Notes are already client-visible in the request. Do not duplicate free
  -- text or accidentally retain pasted credentials in immutable audit data.
  insert into public.outreach_access_audit(client_id, actor_user_id, subject_id, event_type, details)
  values (request_row.client_id, auth.uid(), request_row.id, 'setup_updated', jsonb_build_object(
    'from_status', request_row.status, 'to_status', p_status, 'note_changed', request_row.note <> p_note
  ));
end;
$$;
revoke all on function public.update_outreach_setup_request(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.update_outreach_setup_request(uuid, text, text) to authenticated;

comment on table public.outreach_setup_requests is
  'Assisted setup workflow only. Resolved is not proof of a connected account, verified sender, campaign readiness or launch.';
notify pgrst, 'reload schema';
