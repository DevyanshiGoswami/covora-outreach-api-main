-- A client invitation must not activate workspace access for an identity that
-- was created by an invitation and has never chosen its own password. Auth gives
-- invited identities a random initial password, so the hash cannot be used; the
-- owner invitation trigger (0112) already records every real password change
-- after confirmation, for any identity. Identities created with a password are
-- never invited and are unaffected.
create function outreach_private.invitation_password_pending(p_user uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (
    select 1 from auth.users u
    where u.id = p_user and u.invited_at is not null
      and not exists (select 1 from public.outreach_owner_password_setup s where s.user_id = u.id)
  );
$$;
revoke all on function outreach_private.invitation_password_pending(uuid) from public, anon, authenticated, service_role;

-- Returned columns change, so the function is recreated with its grants.
drop function public.inspect_outreach_invitation(text);
create function public.inspect_outreach_invitation(p_token text)
returns table(invitation_id uuid, client_id uuid, client_name text, role text, expires_at timestamptz, status text, password_required boolean)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare invitation public.outreach_invitations%rowtype;
begin
  invitation := outreach_private.checked_invitation(p_token);
  return query select invitation.id, invitation.client_id, c.name, invitation.role, invitation.expires_at, invitation.status,
    invitation.status = 'pending' and outreach_private.invitation_password_pending(auth.uid())
    from public.clients c where c.id = invitation.client_id;
end;
$$;
revoke all on function public.inspect_outreach_invitation(text) from public, anon, authenticated, service_role;
grant execute on function public.inspect_outreach_invitation(text) to authenticated;

create or replace function public.accept_outreach_invitation(p_token text) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare invitation public.outreach_invitations%rowtype; member_version bigint;
begin
  invitation := outreach_private.checked_invitation(p_token);
  if invitation.status = 'accepted' then return invitation.client_id; end if;
  if outreach_private.invitation_password_pending(auth.uid()) then
    raise exception using errcode = '22023', message = 'Set a password first';
  end if;
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
