-- These permissions are independent of owner membership and default to denied.
-- Grant explicitly by immutable user ID through trusted database administration.
-- Keeping them separate avoids invalidating existing owner invitations on grant.
create table public.outreach_agency_permissions (
  user_id uuid primary key references public.outreach_agency_memberships(user_id) on delete cascade,
  can_manage_clients boolean not null default false,
  can_remove_owners boolean not null default false
);
alter table public.outreach_agency_permissions enable row level security;
create policy outreach_agency_permissions_service on public.outreach_agency_permissions
  for all to service_role using(true) with check(true);
revoke all on public.outreach_agency_permissions from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.outreach_agency_permissions to service_role;

create function outreach_private.require_agency_permission(p_permission text) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare permitted boolean;
begin
  perform 1 from public.outreach_agency_memberships where user_id=auth.uid() and state='active' for share;
  if not found then raise exception using errcode='42501',message='Agency permission denied'; end if;
  select case p_permission when 'clients' then can_manage_clients when 'remove_owners' then can_remove_owners else false end
    into permitted from public.outreach_agency_permissions where user_id=auth.uid() for share;
  if permitted is distinct from true then raise exception using errcode='42501',message='Agency permission denied'; end if;
end; $$;
revoke all on function outreach_private.require_agency_permission(text) from public,anon,authenticated,service_role;

create or replace function public.create_outreach_client(p_id uuid,p_name text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  perform outreach_private.require_agency_permission('clients');
  if p_id is null or p_name is null or length(btrim(p_name)) not between 1 and 100 then
    raise exception using errcode='22023',message='Invalid client'; end if;
  if exists(select 1 from public.clients where id=p_id) then return p_id; end if;
  insert into public.clients(id,slug,name) values(p_id,'outreach-'||p_id::text,btrim(p_name));
  insert into public.client_features(client_id,feature,enabled) values(p_id,'outreach_app',true);
  insert into public.outreach_onboarding_audit(client_id,actor_id,subject_id,event) values(p_id,auth.uid(),p_id,'client_created');
  return p_id;
end; $$;

create or replace function public.remove_outreach_client(p_client_id uuid,p_name text) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare client_name text;
begin
  -- Use the same client lock/order as invitations, connections and reply dispatch.
  select name into client_name from public.clients where id=p_client_id for no key update;
  if not found then raise exception using errcode='42501',message='Client removal denied'; end if;
  perform outreach_private.require_agency_permission('clients');
  if p_name is null or p_name<>client_name then
    raise exception using errcode='22023',message='Client name does not match';
  end if;
  -- A lost success response can be retried, without reviving or re-removing data.
  if exists(select 1 from public.outreach_onboarding_audit where client_id=p_client_id and event='client_removed') then return; end if;
  perform 1 from public.client_features where client_id=p_client_id and feature='outreach_app' and enabled for update;
  if not found then raise exception using errcode='42501',message='Client removal denied'; end if;
  -- An external send already in progress must finish or become uncertain first.
  perform outreach_private.expire_replies(p_client_id);
  if exists(select 1 from public.outreach_reply_commands where client_id=p_client_id and status='sending') then
    raise exception using errcode='55000',message='Reply in progress';
  end if;
  update public.outreach_reply_commands set status='cancelled',error_code='context_changed',updated_at=clock_timestamp()
    where client_id=p_client_id and status in ('queued','preparing');
  update public.outreach_invitations set status='revoked' where client_id=p_client_id and status='pending';
  update public.outreach_memberships set state='revoked' where client_id=p_client_id and state<>'revoked';
  update public.outreach_account_workspaces set enabled=false,version=version+1,updated_at=clock_timestamp() where client_id=p_client_id;
  update public.outreach_reply_workspaces set enabled=false,sync_enabled=false where client_id=p_client_id;
  update public.client_features set enabled=false where client_id=p_client_id and feature='outreach_app';
  insert into public.outreach_onboarding_audit(client_id,actor_id,subject_id,event)
    values(p_client_id,auth.uid(),p_client_id,'client_removed');
end; $$;

create or replace function public.revoke_outreach_owner(p_user_id uuid,p_expected_version bigint) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare m public.outreach_agency_memberships%rowtype;
begin
  perform outreach_private.lock_owner();
  perform outreach_private.require_agency_permission('remove_owners');
  select * into m from public.outreach_agency_memberships where user_id=p_user_id for update;
  if m.user_id is null or m.version is distinct from p_expected_version or m.state='revoked' then raise exception using errcode='22023',message='Refresh current access'; end if;
  if m.state='active' and (select count(*) from public.outreach_agency_memberships where state='active')<=1 then
    raise exception using errcode='22023',message='Keep at least one active owner'; end if;
  update public.outreach_agency_memberships set state='revoked' where user_id=p_user_id;
  with revoked as (update public.outreach_owner_invitations set status='revoked' where status='pending' and (invited_by=p_user_id or target_user_id=p_user_id) returning id)
    insert into public.outreach_owner_audit(actor_id,subject_id,event_type) select auth.uid(),id,'revoked_invitation' from revoked;
  insert into public.outreach_owner_audit(actor_id,subject_id,event_type) values(auth.uid(),p_user_id,'revoked_owner');
end; $$;

create or replace function public.outreach_portal_context() returns jsonb
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select jsonb_build_object('userId',auth.uid(),'isOwner',exists(select 1 from public.outreach_agency_memberships where user_id=auth.uid() and state='active'),
    'canManageClients',exists(select 1 from public.outreach_agency_permissions p join public.outreach_agency_memberships m on m.user_id=p.user_id where p.user_id=auth.uid() and m.state='active' and p.can_manage_clients),
    'workspaces',coalesce((select jsonb_agg(jsonb_build_object('id',client_id,'name',client_name,'role',role) order by client_name,client_id)
      from public.client_outreach_workspaces),'[]'::jsonb));
$$;

create or replace function public.list_outreach_owners() returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  perform outreach_private.lock_owner();
  return jsonb_build_object('userId',auth.uid(),
    'canRemoveOwners',exists(select 1 from public.outreach_agency_permissions where user_id=auth.uid() and can_remove_owners),
    'owners',coalesce((select jsonb_agg(jsonb_build_object('userId',m.user_id,'email',u.email,'state',m.state,'version',m.version) order by u.email)
      from public.outreach_agency_memberships m join auth.users u on u.id=m.user_id),'[]'::jsonb),
    'invitations',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'email',i.email,'status',case when i.status='pending' and i.expires_at<=now() then 'expired' else i.status end,'expiresAt',i.expires_at) order by i.created_at desc)
      from public.outreach_owner_invitations i),'[]'::jsonb));
end; $$;

