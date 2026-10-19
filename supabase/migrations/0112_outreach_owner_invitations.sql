-- Agency ownership is global to this Outreach product, never a client role.
create table public.outreach_owner_invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(btrim(email)) and length(email) <= 254),
  invited_by uuid not null references auth.users(id) on delete cascade,
  inviter_version bigint not null,
  target_user_id uuid references auth.users(id) on delete cascade,
  target_version bigint,
  requires_password boolean not null default false,
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending','accepted','revoked')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_by uuid references auth.users(id) on delete cascade,
  accepted_version bigint
);
create unique index outreach_owner_pending_email on public.outreach_owner_invitations(email) where status='pending';
create table public.outreach_owner_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  subject_id uuid not null,
  event_type text not null check (event_type in ('invited','revoked_invitation','accepted','revoked_owner')),
  created_at timestamptz not null default now()
);
alter table public.outreach_owner_invitations enable row level security;
alter table public.outreach_owner_audit enable row level security;
create policy outreach_owner_invite_service on public.outreach_owner_invitations for all to service_role using (true) with check (true);
create policy outreach_owner_audit_service on public.outreach_owner_audit for all to service_role using (true) with check (true);
revoke all on public.outreach_owner_invitations, public.outreach_owner_audit from public, anon, authenticated, service_role;
grant select,insert,update,delete on public.outreach_owner_invitations, public.outreach_owner_audit to service_role;

-- Track a real password change after account confirmation, not Auth's initial
-- randomly generated invite password. No password or hash is copied here.
create table public.outreach_owner_password_setup (
  user_id uuid primary key references auth.users(id) on delete cascade,
  changed_at timestamptz not null default now()
);
alter table public.outreach_owner_password_setup enable row level security;
revoke all on public.outreach_owner_password_setup from public,anon,authenticated,service_role;
create function outreach_private.record_owner_password_setup() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if old.email_confirmed_at is not null and new.encrypted_password is distinct from old.encrypted_password and coalesce(new.encrypted_password,'')<>'' then
    insert into public.outreach_owner_password_setup(user_id) values(new.id)
      on conflict(user_id) do update set changed_at=now();
  end if;
  return new;
end; $$;
revoke all on function outreach_private.record_owner_password_setup() from public,anon,authenticated,service_role;
create trigger outreach_owner_password_changed after update of encrypted_password on auth.users
  for each row execute function outreach_private.record_owner_password_setup();

create function outreach_private.lock_owner() returns bigint
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v bigint;
begin
  perform pg_advisory_xact_lock(106, 1);
  select version into v from public.outreach_agency_memberships where user_id=auth.uid() and state='active' for share;
  if v is null then raise exception using errcode='42501', message='Owner access unavailable'; end if;
  return v;
end; $$;
revoke all on function outreach_private.lock_owner() from public,anon,authenticated,service_role;

create function public.list_outreach_owners() returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  perform outreach_private.lock_owner();
  return jsonb_build_object('userId',auth.uid(),
    'owners',coalesce((select jsonb_agg(jsonb_build_object('userId',m.user_id,'email',u.email,'state',m.state,'version',m.version) order by u.email)
      from public.outreach_agency_memberships m join auth.users u on u.id=m.user_id),'[]'::jsonb),
    'invitations',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'email',i.email,'status',case when i.status='pending' and i.expires_at<=now() then 'expired' else i.status end,'expiresAt',i.expires_at) order by i.created_at desc)
      from public.outreach_owner_invitations i),'[]'::jsonb));
end; $$;

create function public.create_outreach_owner_invitation(p_email text)
returns table(invitation_id uuid,token text,expires_at timestamptz)
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v bigint; email_value text := lower(btrim(p_email)); target_id uuid; target_membership public.outreach_agency_memberships%rowtype;
  secret text; created public.outreach_owner_invitations%rowtype;
begin
  v := outreach_private.lock_owner();
  if email_value is null or length(email_value)>254 or email_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode='22023', message='Invalid email'; end if;
  select id into target_id from auth.users where lower(email)=email_value;
  select * into target_membership from public.outreach_agency_memberships where user_id=target_id for update;
  if target_membership.state in ('active','suspended') then raise exception using errcode='22023', message='Owner already exists'; end if;
  if (select count(*) from public.outreach_owner_invitations where invited_by=auth.uid() and created_at>now()-interval '1 hour')>=30 then
    raise exception using errcode='22023', message='Invitation limit reached'; end if;
  with old as (update public.outreach_owner_invitations set status='revoked' where email=email_value and status='pending' returning id)
    insert into public.outreach_owner_audit(actor_id,subject_id,event_type) select auth.uid(),id,'revoked_invitation' from old;
  secret := encode(extensions.gen_random_bytes(32),'hex');
  insert into public.outreach_owner_invitations(email,invited_by,inviter_version,target_user_id,target_version,requires_password,token_hash)
    values(email_value,auth.uid(),v,target_id,target_membership.version,(target_id is null or (exists(select 1 from public.outreach_owner_invitations prior where prior.email=email_value and prior.requires_password) and not exists(select 1 from public.outreach_owner_password_setup setup where setup.user_id=target_id))),encode(extensions.digest(secret,'sha256'),'hex')) returning * into created;
  insert into public.outreach_owner_audit(actor_id,subject_id,event_type) values(auth.uid(),created.id,'invited');
  return query select created.id,secret,created.expires_at;
end; $$;

create function outreach_private.checked_owner_invitation(p_token text) returns public.outreach_owner_invitations
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare i public.outreach_owner_invitations%rowtype; u auth.users%rowtype; m public.outreach_agency_memberships%rowtype; inviter public.outreach_agency_memberships%rowtype;
begin
  perform pg_advisory_xact_lock(106,1);
  if auth.uid() is null or p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception using errcode='42501',message='Invitation unavailable'; end if;
  select * into i from public.outreach_owner_invitations where token_hash=encode(extensions.digest(p_token,'sha256'),'hex') for update;
  select * into u from auth.users where id=auth.uid();
  if i.id is null or u.email_confirmed_at is null or lower(u.email) is distinct from i.email
    or (i.target_user_id is not null and i.target_user_id<>auth.uid()) then raise exception using errcode='42501',message='Invitation unavailable'; end if;
  select * into m from public.outreach_agency_memberships where user_id=auth.uid() for update;
  if i.status='accepted' and i.accepted_by=auth.uid() and m.state='active' and m.version=i.accepted_version then return i; end if;
  select * into inviter from public.outreach_agency_memberships where user_id=i.invited_by for share;
  if i.status='pending' and i.expires_at>clock_timestamp() and inviter.state='active' and inviter.version=i.inviter_version
    and ((m.user_id is null and i.target_version is null) or (m.state='revoked' and m.version=i.target_version)) then return i; end if;
  raise exception using errcode='42501',message='Invitation unavailable';
end; $$;
revoke all on function outreach_private.checked_owner_invitation(text) from public,anon,authenticated,service_role;

create function public.inspect_outreach_owner_invitation(p_token text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare i public.outreach_owner_invitations%rowtype;
begin
  i:=outreach_private.checked_owner_invitation(p_token);
  return jsonb_build_object('email',i.email,'status',i.status,'expiresAt',i.expires_at);
end; $$;

create function public.accept_outreach_owner_invitation(p_token text) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare i public.outreach_owner_invitations%rowtype; v bigint;
begin
  i:=outreach_private.checked_owner_invitation(p_token);
  if i.status='accepted' then return; end if;
  if i.requires_password and not exists(select 1 from public.outreach_owner_password_setup where user_id=auth.uid()) then
    raise exception using errcode='22023',message='Set a password first'; end if;
  insert into public.outreach_agency_memberships(user_id) values(auth.uid())
    on conflict(user_id) do update set state='active' returning version into v;
  update public.outreach_owner_invitations set status='accepted',accepted_by=auth.uid(),accepted_version=v where id=i.id;
  insert into public.outreach_owner_audit(actor_id,subject_id,event_type) values(auth.uid(),i.id,'accepted');
end; $$;

create function public.revoke_outreach_owner_invitation(p_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare s text;
begin
  perform outreach_private.lock_owner();
  select status into s from public.outreach_owner_invitations where id=p_id for update;
  if s is null or s='accepted' then raise exception using errcode='22023',message='Invitation cannot be revoked'; end if;
  if s='revoked' then return; end if;
  update public.outreach_owner_invitations set status='revoked' where id=p_id;
  insert into public.outreach_owner_audit(actor_id,subject_id,event_type) values(auth.uid(),p_id,'revoked_invitation');
end; $$;

create function public.revoke_outreach_owner(p_user_id uuid,p_expected_version bigint) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare m public.outreach_agency_memberships%rowtype;
begin
  perform outreach_private.lock_owner();
  select * into m from public.outreach_agency_memberships where user_id=p_user_id for update;
  if m.user_id is null or m.version is distinct from p_expected_version or m.state='revoked' then raise exception using errcode='22023',message='Refresh current access'; end if;
  if m.state='active' and (select count(*) from public.outreach_agency_memberships where state='active')<=1 then
    raise exception using errcode='22023',message='Keep at least one active owner'; end if;
  update public.outreach_agency_memberships set state='revoked' where user_id=p_user_id;
  with revoked as (update public.outreach_owner_invitations set status='revoked' where status='pending' and (invited_by=p_user_id or target_user_id=p_user_id) returning id)
    insert into public.outreach_owner_audit(actor_id,subject_id,event_type) select auth.uid(),id,'revoked_invitation' from revoked;
  insert into public.outreach_owner_audit(actor_id,subject_id,event_type) values(auth.uid(),p_user_id,'revoked_owner');
end; $$;

revoke all on function public.list_outreach_owners(), public.create_outreach_owner_invitation(text), public.inspect_outreach_owner_invitation(text), public.accept_outreach_owner_invitation(text), public.revoke_outreach_owner_invitation(uuid), public.revoke_outreach_owner(uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.list_outreach_owners(), public.create_outreach_owner_invitation(text), public.inspect_outreach_owner_invitation(text), public.accept_outreach_owner_invitation(text), public.revoke_outreach_owner_invitation(uuid), public.revoke_outreach_owner(uuid,bigint) to authenticated;
