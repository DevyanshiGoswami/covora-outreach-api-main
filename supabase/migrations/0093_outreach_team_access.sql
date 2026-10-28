-- Extracted for the independent outbound platform; see docs/schema-extraction.md.
-- Invitations add product membership to an existing verified Auth identity;
-- they never create identities, reset passwords or alter legacy profiles.
create table public.outreach_invitations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and length(email) between 3 and 254),
  role text not null check (role in ('client_admin', 'client_member', 'client_viewer', 'operator')),
  invited_by uuid not null references auth.users(id),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  expires_at timestamptz not null default (now() + interval '7 days'),
  target_user_id uuid references auth.users(id),
  target_membership_version bigint check (target_membership_version > 0),
  accepted_by uuid references auth.users(id),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  check (target_membership_version is null or target_user_id is not null),
  check ((status = 'accepted') = (accepted_by is not null and accepted_at is not null))
);
create unique index outreach_invitation_pending_idx on public.outreach_invitations(client_id, email) where status = 'pending';
create index outreach_invitations_client_idx on public.outreach_invitations(client_id, created_at desc, id);
create index outreach_invitations_inviter_idx on public.outreach_invitations(invited_by, client_id) where status = 'pending';
alter table public.outreach_invitations enable row level security;
create policy outreach_invitations_service on public.outreach_invitations
  for all to service_role using (true) with check (true);
revoke all on table public.outreach_invitations from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.outreach_invitations to service_role;

alter table public.outreach_access_audit drop constraint outreach_access_audit_event_type_check;
alter table public.outreach_access_audit add constraint outreach_access_audit_event_type_check
  check (event_type in ('setup_requested', 'setup_updated', 'invitation_created', 'invitation_revoked', 'invitation_accepted', 'membership_updated'));

-- Every team command takes this same workspace lock before touching authority,
-- memberships or invitations. Other companies can proceed independently.
create function outreach_private.lock_team_workspace(p_client_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform 1 from public.clients c where c.id = p_client_id for no key update;
  if not found then raise exception using errcode = '42501', message = 'Team access denied'; end if;
  perform 1 from public.client_features f where f.client_id = p_client_id
    and f.feature = 'outreach_app' and f.enabled for share;
  if not found then raise exception using errcode = '42501', message = 'Team access denied'; end if;
end;
$$;
revoke all on function outreach_private.lock_team_workspace(uuid) from public, anon, authenticated, service_role;

-- Row locks also fence service-side authority changes until this transaction
-- finishes. Actor IDs passed here are derived inside guarded RPCs only.
create function outreach_private.lock_team_role(p_client_id uuid, p_user_id uuid) returns text
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare agency_state text; member_role text; member_state text;
begin
  select a.state into agency_state from public.outreach_agency_memberships a where a.user_id = p_user_id for share;
  select m.role, m.state into member_role, member_state from public.outreach_memberships m
    where m.client_id = p_client_id and m.user_id = p_user_id for share;
  if agency_state = 'active' then return 'agency_owner'; end if;
  if member_state = 'active' then return member_role; end if;
  return null;
end;
$$;
revoke all on function outreach_private.lock_team_role(uuid, uuid) from public, anon, authenticated, service_role;

create function outreach_private.team_role_allowed(p_manager_role text, p_subject_role text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_subject_role in ('client_admin', 'client_member', 'client_viewer', 'operator') and
    (p_manager_role = 'agency_owner' or (p_manager_role = 'client_admin' and p_subject_role in ('client_member', 'client_viewer'))), false);
$$;
revoke all on function outreach_private.team_role_allowed(text, text) from public, anon, authenticated, service_role;

create function outreach_private.read_team()
returns table(client_id uuid, user_id uuid, email text, role text, state text, version bigint)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select m.client_id, m.user_id, u.email::text, m.role, m.state, m.version
  from public.outreach_memberships m join auth.users u on u.id = m.user_id
  where outreach_private.workspace_role(m.client_id) in ('client_admin', 'agency_owner');
$$;
revoke all on function outreach_private.read_team() from public, anon, authenticated, service_role;
grant execute on function outreach_private.read_team() to authenticated;
create view public.client_outreach_team with (security_invoker = true, security_barrier = true) as select * from outreach_private.read_team();
revoke all on table public.client_outreach_team from public, anon, authenticated, service_role;
grant select on table public.client_outreach_team to authenticated;

create function outreach_private.read_invitations()
returns table(id uuid, client_id uuid, email text, role text, status text, expires_at timestamptz, created_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select i.id, i.client_id, i.email, i.role,
    case when i.status = 'pending' and i.expires_at <= clock_timestamp() then 'expired' else i.status end,
    i.expires_at, i.created_at
  from public.outreach_invitations i where outreach_private.workspace_role(i.client_id) in ('client_admin', 'agency_owner');
$$;
revoke all on function outreach_private.read_invitations() from public, anon, authenticated, service_role;
grant execute on function outreach_private.read_invitations() to authenticated;
create view public.client_outreach_invitations with (security_invoker = true, security_barrier = true) as select * from outreach_private.read_invitations();
revoke all on table public.client_outreach_invitations from public, anon, authenticated, service_role;
grant select on table public.client_outreach_invitations to authenticated;

create function public.create_outreach_invitation(p_client_id uuid, p_email text, p_role text)
returns table(invitation_id uuid, token text, expires_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare manager_role text; intended_email text; target_id uuid; member public.outreach_memberships%rowtype;
  secret text; created public.outreach_invitations%rowtype;
begin
  perform outreach_private.lock_team_workspace(p_client_id);
  manager_role := outreach_private.lock_team_role(p_client_id, auth.uid());
  if manager_role is null or manager_role not in ('client_admin', 'agency_owner') then
    raise exception using errcode = '42501', message = 'Team access denied';
  end if;
  intended_email := lower(btrim(p_email));
  if intended_email is null or length(intended_email) > 254
    or intended_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_role is null or p_role not in ('client_admin', 'client_member', 'client_viewer', 'operator') then
    raise exception using errcode = '22023', message = 'Invalid invitation';
  end if;
  if not outreach_private.team_role_allowed(manager_role, p_role) then
    raise exception using errcode = '42501', message = 'Team access denied';
  end if;
  select u.id into target_id from auth.users u where lower(u.email) = intended_email for share;
  if target_id is not null then
    select m.* into member from public.outreach_memberships m
      where m.user_id = target_id and m.client_id = p_client_id for update;
    if found and member.state <> 'revoked' then
      raise exception using errcode = '22023', message = 'Use membership management for current access';
    end if;
    if member.user_id is not null and not outreach_private.team_role_allowed(manager_role, member.role) then
      raise exception using errcode = '42501', message = 'Team access denied';
    end if;
  end if;
  -- Reissuing is also revocation: it must not bypass the authority required
  -- by revoke_outreach_invitation for an existing higher-privilege offer.
  if exists (select 1 from public.outreach_invitations i
    where i.client_id = p_client_id and i.email = intended_email and i.status = 'pending'
      and not outreach_private.team_role_allowed(manager_role, i.role)) then
    raise exception using errcode = '42501', message = 'Team access denied';
  end if;
  with revoked as (
    update public.outreach_invitations i set status = 'revoked'
      where i.client_id = p_client_id and i.email = intended_email and i.status = 'pending' returning i.*
  ) insert into public.outreach_access_audit(client_id, actor_user_id, subject_id, event_type, details)
    select p_client_id, auth.uid(), r.id, 'invitation_revoked', jsonb_build_object('role', r.role, 'reason', 'reissued') from revoked r;
  secret := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.outreach_invitations(client_id, email, role, invited_by, token_hash, target_user_id, target_membership_version)
    values (p_client_id, intended_email, p_role, auth.uid(), encode(extensions.digest(secret, 'sha256'), 'hex'), target_id, member.version)
    returning * into created;
  insert into public.outreach_access_audit(client_id, actor_user_id, subject_id, event_type, details)
    values (p_client_id, auth.uid(), created.id, 'invitation_created', jsonb_build_object('role', p_role));
  return query select created.id, secret, created.expires_at;
end;
$$;
revoke all on function public.create_outreach_invitation(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.create_outreach_invitation(uuid, text, text) to authenticated;

-- Inspection and acceptance have the same privacy gate. No metadata is
-- returned for an invalid token, wrong identity, stale grant or lost inviter.
create function outreach_private.checked_invitation(p_token text) returns public.outreach_invitations
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare invitation public.outreach_invitations%rowtype; actor auth.users%rowtype;
  member public.outreach_memberships%rowtype; inviter_role text;
begin
  if auth.uid() is null or p_token is null or p_token !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'Invitation unavailable';
  end if;
  select i.* into invitation from public.outreach_invitations i
    where i.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if not found then raise exception using errcode = '42501', message = 'Invitation unavailable'; end if;
  begin
    perform outreach_private.lock_team_workspace(invitation.client_id);
  exception when insufficient_privilege then
    raise exception using errcode = '42501', message = 'Invitation unavailable';
  end;
  select u.* into actor from auth.users u where u.id = auth.uid() for share;
  if actor.email_confirmed_at is null or lower(actor.email) is distinct from invitation.email then
    raise exception using errcode = '42501', message = 'Invitation unavailable';
  end if;
  -- Follow the membership-before-invitation order used by every mutation.
  inviter_role := outreach_private.lock_team_role(invitation.client_id, invitation.invited_by);
  select m.* into member from public.outreach_memberships m
    where m.client_id = invitation.client_id and m.user_id = auth.uid() for update;
  select i.* into invitation from public.outreach_invitations i where i.id = invitation.id for update;
  if invitation.status = 'accepted' then
    if invitation.accepted_by = auth.uid() and member.state = 'active' then return invitation; end if;
  elsif invitation.status = 'pending' and invitation.expires_at > clock_timestamp()
    and outreach_private.team_role_allowed(inviter_role, invitation.role)
    and (invitation.target_user_id is null or invitation.target_user_id = auth.uid()) then
    if member.user_id is null and invitation.target_membership_version is null then return invitation; end if;
    if member.state = 'revoked' and member.version = invitation.target_membership_version
      and outreach_private.team_role_allowed(inviter_role, member.role) then return invitation; end if;
  end if;
  raise exception using errcode = '42501', message = 'Invitation unavailable';
end;
$$;
revoke all on function outreach_private.checked_invitation(text) from public, anon, authenticated, service_role;

create function public.inspect_outreach_invitation(p_token text)
returns table(invitation_id uuid, client_id uuid, client_name text, role text, expires_at timestamptz, status text)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare invitation public.outreach_invitations%rowtype;
begin
  invitation := outreach_private.checked_invitation(p_token);
  return query select invitation.id, invitation.client_id, c.name, invitation.role, invitation.expires_at, invitation.status
    from public.clients c where c.id = invitation.client_id;
end;
$$;
revoke all on function public.inspect_outreach_invitation(text) from public, anon, authenticated, service_role;
grant execute on function public.inspect_outreach_invitation(text) to authenticated;

create function public.accept_outreach_invitation(p_token text) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare invitation public.outreach_invitations%rowtype; member_version bigint;
begin
  invitation := outreach_private.checked_invitation(p_token);
  if invitation.status = 'accepted' then return invitation.client_id; end if;
  if invitation.target_membership_version is null then
    insert into public.outreach_memberships(user_id, client_id, role, state)
      values (auth.uid(), invitation.client_id, invitation.role, 'active')
      on conflict (user_id, client_id) do nothing returning version into member_version;
  else
    update public.outreach_memberships set role = invitation.role, state = 'active'
      where user_id = auth.uid() and client_id = invitation.client_id
        and state = 'revoked' and version = invitation.target_membership_version
      returning version into member_version;
  end if;
  if member_version is null then raise exception using errcode = '42501', message = 'Invitation unavailable'; end if;
  update public.outreach_invitations set status = 'accepted', accepted_by = auth.uid(), accepted_at = clock_timestamp(),
    target_user_id = auth.uid() where id = invitation.id;
  insert into public.outreach_access_audit(client_id, actor_user_id, subject_id, event_type, details)
    values (invitation.client_id, auth.uid(), invitation.id, 'invitation_accepted',
      jsonb_build_object('role', invitation.role, 'state', 'active', 'version', member_version));
  return invitation.client_id;
end;
$$;
revoke all on function public.accept_outreach_invitation(text) from public, anon, authenticated, service_role;
grant execute on function public.accept_outreach_invitation(text) to authenticated;

create function public.revoke_outreach_invitation(p_invitation_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare invitation public.outreach_invitations%rowtype; manager_role text;
begin
  select i.* into invitation from public.outreach_invitations i where i.id = p_invitation_id;
  if not found then raise exception using errcode = '42501', message = 'Team access denied'; end if;
  perform outreach_private.lock_team_workspace(invitation.client_id);
  manager_role := outreach_private.lock_team_role(invitation.client_id, auth.uid());
  if not outreach_private.team_role_allowed(manager_role, invitation.role) then
    raise exception using errcode = '42501', message = 'Team access denied';
  end if;
  select i.* into invitation from public.outreach_invitations i where i.id = p_invitation_id for update;
  if invitation.status = 'accepted' then raise exception using errcode = '22023', message = 'Invitation already accepted'; end if;
  if invitation.status = 'revoked' then return; end if;
  update public.outreach_invitations set status = 'revoked' where id = invitation.id;
  insert into public.outreach_access_audit(client_id, actor_user_id, subject_id, event_type, details)
    values (invitation.client_id, auth.uid(), invitation.id, 'invitation_revoked', jsonb_build_object('role', invitation.role));
end;
$$;
revoke all on function public.revoke_outreach_invitation(uuid) from public, anon, authenticated, service_role;
grant execute on function public.revoke_outreach_invitation(uuid) to authenticated;

create function public.change_outreach_membership(p_client_id uuid, p_user_id uuid, p_role text, p_state text, p_expected_version bigint) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare manager_role text; member public.outreach_memberships%rowtype; member_version bigint; subject_email text;
begin
  perform outreach_private.lock_team_workspace(p_client_id);
  manager_role := outreach_private.lock_team_role(p_client_id, auth.uid());
  if manager_role is null or manager_role not in ('client_admin', 'agency_owner') then
    raise exception using errcode = '42501', message = 'Team access denied';
  end if;
  if p_role is null or p_role not in ('client_admin', 'client_member', 'client_viewer', 'operator')
    or p_state is null or p_state not in ('active', 'suspended', 'revoked')
    or p_expected_version is null or p_expected_version < 1 then
    raise exception using errcode = '22023', message = 'Invalid membership change';
  end if;
  select m.* into member from public.outreach_memberships m
    where m.client_id = p_client_id and m.user_id = p_user_id for update;
  if not found or not outreach_private.team_role_allowed(manager_role, member.role)
    or not outreach_private.team_role_allowed(manager_role, p_role) then
    raise exception using errcode = '42501', message = 'Team access denied';
  end if;
  if member.version <> p_expected_version then raise exception using errcode = '22023', message = 'Membership changed; refresh and try again'; end if;
  if member.role = p_role and member.state = p_state then return; end if;
  update public.outreach_memberships set role = p_role, state = p_state
    where client_id = p_client_id and user_id = p_user_id returning version into member_version;
  select lower(u.email) into subject_email from auth.users u where u.id = p_user_id;
  with revoked as (
    update public.outreach_invitations i set status = 'revoked' where i.client_id = p_client_id and i.status = 'pending'
      and (i.target_user_id = p_user_id or i.email = subject_email
        or (i.invited_by = p_user_id and (p_role <> 'client_admin' or p_state <> 'active')
          and not exists (select 1 from public.outreach_agency_memberships a where a.user_id = p_user_id and a.state = 'active')))
      returning i.*
  ) insert into public.outreach_access_audit(client_id, actor_user_id, subject_id, event_type, details)
    select p_client_id, auth.uid(), r.id, 'invitation_revoked', jsonb_build_object('role', r.role, 'reason', 'membership_changed') from revoked r;
  insert into public.outreach_access_audit(client_id, actor_user_id, subject_id, event_type, details)
    values (p_client_id, auth.uid(), p_user_id, 'membership_updated', jsonb_build_object(
      'from_role', member.role, 'role', p_role, 'from_state', member.state, 'state', p_state, 'from_version', member.version, 'version', member_version));
end;
$$;
revoke all on function public.change_outreach_membership(uuid, uuid, text, text, bigint) from public, anon, authenticated, service_role;
grant execute on function public.change_outreach_membership(uuid, uuid, text, text, bigint) to authenticated;

notify pgrst, 'reload schema';
