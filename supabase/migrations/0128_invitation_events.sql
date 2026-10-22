-- Diagnostic record of each step of adding a user: creating the invitation, opening it and
-- accepting it. Failures keep the specific reason that the person was deliberately not shown.
-- Never holds invitation or login tokens, passwords or full email addresses. Server-only.
create table public.outreach_invitation_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  step text not null check (step in ('create','inspect','accept')),
  outcome text not null check (outcome in ('ok','failed')),
  reason text not null check (reason ~ '^[a-z0-9_]{1,60}$'),
  client_id uuid,
  invitation_id uuid,
  actor_user_id uuid,
  invitee text check (invitee is null or length(invitee) <= 260),
  detail text check (detail is null or length(detail) <= 200)
);
create index outreach_invitation_events_created_idx on public.outreach_invitation_events (created_at desc);
create index outreach_invitation_events_invitation_idx on public.outreach_invitation_events (invitation_id) where invitation_id is not null;
alter table public.outreach_invitation_events enable row level security;
revoke all on public.outreach_invitation_events from public,anon,authenticated,service_role;
grant select,insert,delete on public.outreach_invitation_events to service_role;

-- Why an invitation link would be refused for this user, using the same checks, in the same order,
-- as outreach_private.checked_invitation. Read-only and server-only: the person still only sees
-- that the invitation is unavailable. Returns 'ok' when the link would be accepted.
create function public.diagnose_outreach_invitation(p_token text,p_user uuid default null)
returns table(reason text,invitation_id uuid,client_id uuid,invitee text)
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare i public.outreach_invitations%rowtype; u auth.users%rowtype; m public.outreach_memberships%rowtype; inviter_role text; why text;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then return query select 'malformed_link'::text,null::uuid,null::uuid,null::text; return; end if;
  select * into i from public.outreach_invitations x where x.token_hash=encode(extensions.digest(p_token,'sha256'),'hex');
  if not found then return query select 'unknown_link'::text,null::uuid,null::uuid,null::text; return; end if;
  if p_user is null then why:='signed_out';
  elsif not exists(select 1 from public.clients c where c.id=i.client_id)
    or not exists(select 1 from public.client_features f where f.client_id=i.client_id and f.feature='outreach_app' and f.enabled) then why:='workspace_disabled';
  else
    select * into u from auth.users where id=p_user;
    select * into m from public.outreach_memberships x where x.client_id=i.client_id and x.user_id=p_user;
    select case when exists(select 1 from public.outreach_agency_memberships a where a.user_id=i.invited_by and a.state='active') then 'agency_owner'
      else (select x.role from public.outreach_memberships x where x.client_id=i.client_id and x.user_id=i.invited_by and x.state='active') end into inviter_role;
    why:=case
      when u.id is null then 'signed_out'
      when u.email_confirmed_at is null then 'email_unconfirmed'
      when lower(u.email) is distinct from i.email then 'different_account'
      when i.status='accepted' then case when i.accepted_by=p_user and m.state='active' then 'ok' else 'already_used' end
      when i.status='revoked' then 'replaced_or_revoked'
      when i.status='expired' or i.expires_at<=clock_timestamp() then 'expired'
      when not outreach_private.team_role_allowed(inviter_role,i.role) then 'inviter_lost_access'
      when i.target_user_id is not null and i.target_user_id<>p_user then 'different_account'
      when m.user_id is null and i.target_membership_version is null then 'ok'
      when m.user_id is not null and m.state<>'revoked' then 'already_member'
      when m.state='revoked' and m.version=i.target_membership_version and outreach_private.team_role_allowed(inviter_role,m.role) then 'ok'
      else 'membership_changed' end;
  end if;
  return query select why,i.id,i.client_id,i.email;
end; $$;
revoke all on function public.diagnose_outreach_invitation(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.diagnose_outreach_invitation(text,uuid) to service_role;

-- A login created by an invitation whose person never finished joining: never a member or owner
-- anywhere, never accepted or sent an invitation and no other Covora data. Re-adding such a person
-- may give them a fresh one-time sign-in link, exactly as adding a brand-new person does. Any login
-- that was ever used keeps "sign in with your password" only, so nobody can take it over.
create function public.resumable_outreach_login(p_user uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select exists(select 1 from auth.users u where u.id=p_user and u.invited_at is not null and u.deleted_at is null
      and not coalesce(u.is_anonymous,false) and not coalesce(u.is_sso_user,false) and (u.banned_until is null or u.banned_until<now()))
    and not exists(select 1 from public.outreach_memberships x where x.user_id=p_user)
    and not exists(select 1 from public.outreach_agency_memberships x where x.user_id=p_user)
    and not exists(select 1 from public.outreach_people x where x.user_id=p_user)
    and not exists(select 1 from public.outreach_invitations x where x.accepted_by=p_user or x.invited_by=p_user)
    and not exists(select 1 from public.outreach_owner_invitations x where x.accepted_by=p_user or x.invited_by=p_user or x.target_user_id=p_user)
    and not exists(select 1 from public.outreach_owner_password_setup x where x.user_id=p_user)
    and not exists(select 1 from public.outreach_setup_requests x where x.requested_by=p_user)
    and not exists(select 1 from public.outreach_lead_alert_deliveries x where x.user_id=p_user)
    and not exists(select 1 from public.outreach_lead_alert_policies x where x.configured_by=p_user);
$$;
revoke all on function public.resumable_outreach_login(uuid) from public,anon,authenticated,service_role;
grant execute on function public.resumable_outreach_login(uuid) to service_role;
notify pgrst,'reload schema';
