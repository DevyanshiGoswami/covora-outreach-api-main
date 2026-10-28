-- Extracted for the independent outbound platform; see docs/schema-extraction.md.
-- Agency-operated registration and read-only verification. No mailbox creation,
-- sending permission, domain ownership proof or campaign readiness is implied.
create table public.outreach_account_workspaces (
  client_id uuid primary key references public.clients(id) on delete cascade,
  remote_workspace_id uuid not null unique,
  credential_ref text not null unique check (credential_ref ~ '^OUTREACH_INSTANTLY_[A-Z0-9_]{1,100}$'),
  enabled boolean not null default false,
  version bigint not null default 1 check (version > 0),
  last_check_started_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.outreach_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.outreach_account_workspaces(client_id) on delete cascade,
  email text not null unique check (email = lower(btrim(email)) and length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  display_name text not null default '' check (length(display_name) <= 100),
  state text not null default 'unverified' check (state in ('unverified','connected','paused','maintenance','setting_up','needs_attention')),
  last_checked_at timestamptz,
  last_attempt_at timestamptz,
  last_connected_at timestamptz,
  check_error boolean not null default false,
  current_check_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id,client_id)
);
create index outreach_accounts_client_idx on public.outreach_accounts(client_id,created_at,id);
create table public.outreach_account_checks (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  client_id uuid not null,
  actor_user_id uuid not null,
  authority_stamp text not null,
  workspace_version bigint not null,
  expires_at timestamptz not null default now() + interval '60 seconds',
  completed_at timestamptz,
  error_code text check (error_code in ('check_unavailable','scope_mismatch','identity_mismatch')),
  created_at timestamptz not null default now(),
  foreign key(account_id,client_id) references public.outreach_accounts(id,client_id) on delete cascade
);
create index outreach_account_checks_account_idx on public.outreach_account_checks(account_id,created_at desc);

alter table public.outreach_account_workspaces enable row level security;
alter table public.outreach_accounts enable row level security;
alter table public.outreach_account_checks enable row level security;
create policy outreach_account_workspaces_service on public.outreach_account_workspaces for all to service_role using(true) with check(true);
create policy outreach_accounts_service on public.outreach_accounts for all to service_role using(true) with check(true);
create policy outreach_account_checks_service on public.outreach_account_checks for all to service_role using(true) with check(true);
revoke all on public.outreach_account_workspaces, public.outreach_accounts, public.outreach_account_checks from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.outreach_account_workspaces, public.outreach_accounts, public.outreach_account_checks to service_role;

alter table public.outreach_access_audit drop constraint outreach_access_audit_event_type_check;
alter table public.outreach_access_audit add constraint outreach_access_audit_event_type_check check (event_type in (
  'setup_requested','setup_updated','invitation_created','invitation_revoked','invitation_accepted','membership_updated',
  'account_workspace_configured','account_registered','account_check_started','account_check_completed'
));

create function outreach_private.lock_account_authority(p_client_id uuid,p_actor_id uuid) returns text
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare actor_role text; actor_version bigint;
begin
  perform outreach_private.lock_team_workspace(p_client_id);
  actor_role := outreach_private.lock_team_role(p_client_id,p_actor_id);
  if actor_role is null or actor_role not in ('agency_owner','operator') then
    raise exception using errcode='42501',message='Account access denied';
  end if;
  if actor_role='agency_owner' then
    select version into actor_version from public.outreach_agency_memberships where user_id=p_actor_id;
  else
    select version into actor_version from public.outreach_memberships where user_id=p_actor_id and client_id=p_client_id;
  end if;
  return actor_role || ':' || actor_version::text;
end; $$;
revoke all on function outreach_private.lock_account_authority(uuid,uuid) from public,anon,authenticated,service_role;

create function public.configure_outreach_account_workspace(p_client_id uuid,p_remote_workspace_id uuid,p_credential_ref text,p_enabled boolean) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare stamp text;
begin
  stamp := outreach_private.lock_account_authority(p_client_id,auth.uid());
  if stamp not like 'agency_owner:%' then raise exception using errcode='42501',message='Account configuration denied'; end if;
  if p_remote_workspace_id is null or p_credential_ref is null or p_credential_ref !~ '^OUTREACH_INSTANTLY_[A-Z0-9_]{1,100}$' or p_enabled is null then
    raise exception using errcode='22023',message='Invalid account configuration';
  end if;
  insert into public.outreach_account_workspaces(client_id,remote_workspace_id,credential_ref,enabled)
    values(p_client_id,p_remote_workspace_id,p_credential_ref,p_enabled)
    on conflict(client_id) do update set remote_workspace_id=excluded.remote_workspace_id,credential_ref=excluded.credential_ref,
      enabled=excluded.enabled,version=outreach_account_workspaces.version+1,last_check_started_at=null,updated_at=now();
  update public.outreach_accounts set state='unverified',last_checked_at=null,last_connected_at=null,last_attempt_at=null,
    check_error=false,current_check_id=null,updated_at=now() where client_id=p_client_id;
  insert into public.outreach_access_audit(client_id,actor_user_id,subject_id,event_type,details)
    values(p_client_id,auth.uid(),p_client_id,'account_workspace_configured',jsonb_build_object('enabled',p_enabled));
exception when unique_violation then raise exception using errcode='22023',message='Account configuration unavailable';
end; $$;
revoke all on function public.configure_outreach_account_workspace(uuid,uuid,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.configure_outreach_account_workspace(uuid,uuid,text,boolean) to authenticated;

-- Canonical account identity is reserved within this independent product.
-- Match JavaScript trim(), including surrounding Unicode whitespace.
create function outreach_private.account_email(p_value text) returns text
language sql immutable set search_path=pg_catalog,pg_temp as $$
  select lower(btrim(p_value, E' \t\n\r\f\013' || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'));
$$;
revoke all on function outreach_private.account_email(text) from public,anon,authenticated,service_role;

create function outreach_private.guard_account_reservation() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if tg_op='UPDATE' and (new.email is distinct from old.email or new.client_id is distinct from old.client_id or new.id is distinct from old.id) then
    raise exception using errcode='22023',message='Account identity cannot change';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.email,913));

  return new;
end; $$;
revoke all on function outreach_private.guard_account_reservation() from public,anon,authenticated,service_role;
create trigger outreach_account_reservation before insert or update of email,client_id,id on public.outreach_accounts for each row execute function outreach_private.guard_account_reservation();

create function public.register_outreach_account(p_client_id uuid,p_email text,p_display_name text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare address text:=outreach_private.account_email(p_email); account_id uuid; prior_client uuid;
begin
  perform outreach_private.lock_account_authority(p_client_id,auth.uid());
  if address is null or length(address)>254 or address !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_display_name is null or length(p_display_name)>100 then raise exception using errcode='22023',message='Invalid account registration'; end if;
  perform 1 from public.outreach_account_workspaces where client_id=p_client_id and enabled for share;
  if not found then raise exception using errcode='42501',message='Account configuration unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(address,913));
  select id,client_id into account_id,prior_client from public.outreach_accounts where email=address;
  if found then
    if prior_client<>p_client_id then raise exception using errcode='22023',message='Account registration unavailable'; end if;
    return account_id;
  end if;
  insert into public.outreach_accounts(client_id,email,display_name,created_by) values(p_client_id,address,btrim(p_display_name),auth.uid()) returning id into account_id;
  insert into public.outreach_access_audit(client_id,actor_user_id,subject_id,event_type) values(p_client_id,auth.uid(),account_id,'account_registered');
  return account_id;
exception when unique_violation then raise exception using errcode='22023',message='Account registration unavailable';
end; $$;
revoke all on function public.register_outreach_account(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.register_outreach_account(uuid,text,text) to authenticated;

create function public.begin_outreach_account_check(p_client_id uuid,p_account_id uuid) returns uuid
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare stamp text; account_row public.outreach_accounts%rowtype; workspace_row public.outreach_account_workspaces%rowtype; check_id uuid; checked_at timestamptz;
begin
  stamp := outreach_private.lock_account_authority(p_client_id,auth.uid());
  select * into workspace_row from public.outreach_account_workspaces where client_id=p_client_id and enabled for update;
  if not found then raise exception using errcode='42501',message='Account configuration unavailable'; end if;
  select * into account_row from public.outreach_accounts where id=p_account_id and client_id=p_client_id for update;
  if not found then raise exception using errcode='42501',message='Account access denied'; end if;
  checked_at := clock_timestamp();
  if exists(select 1 from public.outreach_account_checks where id=account_row.current_check_id and completed_at is null and expires_at>checked_at)
    or account_row.last_attempt_at>checked_at-interval '30 seconds'
    or workspace_row.last_check_started_at>checked_at-interval '2 seconds' then
    raise exception using errcode='22023',message='Wait before checking this account again';
  end if;
  insert into public.outreach_account_checks(account_id,client_id,actor_user_id,authority_stamp,workspace_version,expires_at)
    values(p_account_id,p_client_id,auth.uid(),stamp,workspace_row.version,checked_at+interval '60 seconds') returning id into check_id;
  update public.outreach_accounts set current_check_id=check_id,last_attempt_at=checked_at,updated_at=checked_at where id=p_account_id;
  update public.outreach_account_workspaces set last_check_started_at=checked_at where client_id=p_client_id;
  insert into public.outreach_access_audit(client_id,actor_user_id,subject_id,event_type) values(p_client_id,auth.uid(),p_account_id,'account_check_started');
  return check_id;
end; $$;
revoke all on function public.begin_outreach_account_check(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.begin_outreach_account_check(uuid,uuid) to authenticated;

create function public.read_outreach_account_check(p_check_id uuid)
returns table(account_id uuid,client_id uuid,email text,remote_workspace_id uuid,credential_ref text)
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare check_row public.outreach_account_checks%rowtype; stamp text;
begin
  select * into check_row from public.outreach_account_checks where id=p_check_id;
  if not found or check_row.completed_at is not null or check_row.expires_at<=clock_timestamp() then return; end if;
  stamp := outreach_private.lock_account_authority(check_row.client_id,check_row.actor_user_id);
  if stamp<>check_row.authority_stamp or check_row.expires_at<=clock_timestamp() then return; end if;
  return query select a.id,a.client_id,a.email,w.remote_workspace_id,w.credential_ref
    from public.outreach_accounts a join public.outreach_account_workspaces w on w.client_id=a.client_id
    where a.id=check_row.account_id and a.current_check_id=p_check_id and w.enabled and w.version=check_row.workspace_version;
end; $$;
revoke all on function public.read_outreach_account_check(uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_outreach_account_check(uuid) to service_role;

create function public.finish_outreach_account_check(p_check_id uuid,p_state text default null,p_error_code text default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare check_row public.outreach_account_checks%rowtype; stamp text; workspace_row public.outreach_account_workspaces%rowtype; account_row public.outreach_accounts%rowtype; checked_at timestamptz;
begin
  if (p_state is null)=(p_error_code is null) or (p_state is not null and p_state not in ('connected','paused','maintenance','setting_up','needs_attention'))
    or (p_error_code is not null and p_error_code not in ('check_unavailable','scope_mismatch','identity_mismatch')) then
    raise exception using errcode='22023',message='Invalid account check';
  end if;
  select * into check_row from public.outreach_account_checks where id=p_check_id;
  if not found then return false; end if;
  stamp := outreach_private.lock_account_authority(check_row.client_id,check_row.actor_user_id);
  select * into workspace_row from public.outreach_account_workspaces where client_id=check_row.client_id for update;
  select * into account_row from public.outreach_accounts where id=check_row.account_id for update;
  select * into check_row from public.outreach_account_checks where id=p_check_id for update;
  checked_at := clock_timestamp();
  if not workspace_row.enabled or workspace_row.version<>check_row.workspace_version or stamp<>check_row.authority_stamp
    or account_row.current_check_id is distinct from p_check_id or check_row.completed_at is not null or check_row.expires_at<=checked_at then return false; end if;
  update public.outreach_accounts set state=coalesce(p_state,state),check_error=(p_error_code is not null),
    last_checked_at=case when p_state is not null then checked_at else last_checked_at end,
    last_connected_at=case when p_state='connected' then checked_at else last_connected_at end,current_check_id=null,updated_at=checked_at where id=check_row.account_id;
  update public.outreach_account_checks set completed_at=checked_at,error_code=p_error_code where id=p_check_id;
  insert into public.outreach_access_audit(client_id,actor_user_id,subject_id,event_type,details)
    values(check_row.client_id,check_row.actor_user_id,check_row.account_id,'account_check_completed',jsonb_build_object('state',p_state,'check_error',p_error_code is not null));
  return true;
exception when insufficient_privilege then return false;
end; $$;
revoke all on function public.finish_outreach_account_check(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_outreach_account_check(uuid,text,text) to service_role;

create function outreach_private.read_accounts()
returns table(id uuid,client_id uuid,channel text,email text,display_name text,state text,last_checked_at timestamptz,last_attempt_at timestamptz,last_connected_at timestamptz,check_error boolean,updated_at timestamptz)
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select a.id,a.client_id,'email'::text,a.email,a.display_name,a.state,a.last_checked_at,a.last_attempt_at,a.last_connected_at,
    (a.check_error or (a.current_check_id is not null and not exists(select 1 from public.outreach_account_checks c where c.id=a.current_check_id and c.completed_at is null and c.expires_at>now()))),a.updated_at
    from public.outreach_accounts a where outreach_private.can_read(a.client_id);
$$;
revoke all on function outreach_private.read_accounts() from public,anon,authenticated,service_role;
grant execute on function outreach_private.read_accounts() to authenticated;
create view public.client_outreach_accounts with(security_invoker=true,security_barrier=true) as select * from outreach_private.read_accounts();
revoke all on public.client_outreach_accounts from public,anon,authenticated,service_role;
grant select on public.client_outreach_accounts to authenticated;
