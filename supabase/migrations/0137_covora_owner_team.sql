-- Active agency ownership is also Covora team access. It is a derived grant,
-- never a copied direct membership that could survive owner revocation.
create function outreach_private.is_covora_owner(p_client uuid,p_user uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select exists(select 1 from public.clients c join public.outreach_agency_memberships a on a.user_id=p_user
   where c.id=p_client and c.slug='covora' and a.state='active');
$$;
revoke all on function outreach_private.is_covora_owner(uuid,uuid) from public,anon,authenticated,service_role;

-- Preserve existing member authority stamps where independent self-connection
-- access already exists. Otherwise bind the session to the owner's version.
create function outreach_private.uses_covora_owner_access(p_client uuid,p_user uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select outreach_private.is_covora_owner(p_client,p_user) and not exists(
   select 1 from public.outreach_memberships where client_id=p_client and user_id=p_user
     and state='active' and role in ('client_admin','client_member'));
$$;
revoke all on function outreach_private.uses_covora_owner_access(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function outreach_private.sync_member_person(p_client uuid,p_user uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare address text; display text;
begin
  if not exists(select 1 from public.outreach_memberships where client_id=p_client and user_id=p_user
    and state='active' and role in ('client_admin','client_member','client_viewer'))
    and not outreach_private.is_covora_owner(p_client,p_user) then return; end if;
  -- Identity is attached only once, using a verified address. Subsequent login
  -- email changes never transfer a sender or its saved provider connections.
  if exists(select 1 from public.outreach_people where client_id=p_client and user_id=p_user) then return; end if;
  select lower(btrim(u.email)),coalesce(nullif(btrim(p.full_name),''),split_part(u.email,'@',1))
    into address,display from auth.users u left join public.profiles p on p.id=u.id
    where u.id=p_user and u.email_confirmed_at is not null;
  if address is null then return; end if;
  insert into public.outreach_people(client_id,user_id,source,name,email)
    values(p_client,p_user,'team',left(display,100),address)
    on conflict(client_id,email) do update set user_id=excluded.user_id,source='team'
    where outreach_people.user_id is null and outreach_people.source='external';
end; $$;
revoke all on function outreach_private.sync_member_person(uuid,uuid) from public,anon,authenticated,service_role;


create function outreach_private.owner_covora_person_changed() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c uuid;
begin
 if new.state='active' then
   select id into c from public.clients where slug='covora';
   if c is not null then perform outreach_private.sync_member_person(c,new.user_id); end if;
 end if;
 return new;
end; $$;
revoke all on function outreach_private.owner_covora_person_changed() from public,anon,authenticated,service_role;
create trigger outreach_owner_covora_person after insert or update on public.outreach_agency_memberships
 for each row execute function outreach_private.owner_covora_person_changed();

create function outreach_private.covora_team_created() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare a record;
begin
 if new.slug='covora' then
   for a in select user_id from public.outreach_agency_memberships where state='active' loop
     perform outreach_private.sync_member_person(new.id,a.user_id);
   end loop;
 end if;
 return new;
end; $$;
revoke all on function outreach_private.covora_team_created() from public,anon,authenticated,service_role;
create trigger outreach_covora_team_created after insert or update of slug on public.clients
 for each row execute function outreach_private.covora_team_created();

create or replace function outreach_private.confirmed_member_person() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare m record;
begin
 for m in select client_id from public.outreach_memberships where user_id=new.id
   union select id from public.clients where outreach_private.is_covora_owner(id,new.id) loop
   perform outreach_private.sync_member_person(m.client_id,new.id);
 end loop;
 return new;
end; $$;

create or replace function outreach_private.person_can_connect(p_person uuid,p_actor uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select coalesce((select case when p.source='team' then p.user_id=p_actor and (
   exists(select 1 from public.outreach_memberships m where m.client_id=p.client_id and m.user_id=p_actor
     and m.state='active' and m.role in ('client_admin','client_member'))
   or outreach_private.is_covora_owner(p.client_id,p_actor))
   else exists(select 1 from public.outreach_agency_memberships where user_id=p_actor and state='active')
     or exists(select 1 from public.outreach_memberships where client_id=p.client_id and user_id=p_actor
       and state='active' and role in ('client_admin','operator')) end
   from public.outreach_people p where p.id=p_person),false);
$$;

-- One row per identity, even when both grants exist. Direct membership rows
-- are never modified by synchronization. Effective owner access is read live.
create function outreach_private.read_team_with_owners()
returns table(client_id uuid,user_id uuid,email text,role text,state text,version bigint,is_agency_owner boolean)
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 with identities as (
   select m.client_id,m.user_id from public.outreach_memberships m
   union
   select c.id,a.user_id from public.clients c cross join public.outreach_agency_memberships a
     where c.slug='covora' and a.state='active'
 )
 select i.client_id,i.user_id,u.email::text,coalesce(m.role,'client_member'),
   case when outreach_private.is_covora_owner(i.client_id,i.user_id) then 'active' else m.state end,
   coalesce(m.version,a.version),outreach_private.is_covora_owner(i.client_id,i.user_id)
 from identities i join auth.users u on u.id=i.user_id
 left join public.outreach_memberships m on m.client_id=i.client_id and m.user_id=i.user_id
 left join public.outreach_agency_memberships a on a.user_id=i.user_id
 where outreach_private.workspace_role(i.client_id) in ('client_admin','agency_owner');
$$;
revoke all on function outreach_private.read_team_with_owners() from public,anon,authenticated,service_role;
grant execute on function outreach_private.read_team_with_owners() to authenticated;
create or replace view public.client_outreach_team with (security_invoker=true,security_barrier=true)
 as select * from outreach_private.read_team_with_owners();
drop function outreach_private.read_team();

create or replace function outreach_private.person_connection_authority(p_person uuid,p_actor uuid) returns text
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare p public.outreach_people%rowtype; r text; v bigint;
begin
  select * into p from public.outreach_people where id=p_person;
  if not found then raise insufficient_privilege; end if;
  perform outreach_private.lock_team_workspace(p.client_id);
  r:=outreach_private.lock_team_role(p.client_id,p_actor);
  select * into p from public.outreach_people where id=p_person for share;
  if r is null or not outreach_private.person_can_connect(p_person,p_actor) then raise insufficient_privilege; end if;
  if p.source='team' and outreach_private.uses_covora_owner_access(p.client_id,p_actor) then
    select version into v from public.outreach_agency_memberships where user_id=p_actor;
    return 'covora_owner:'||p_actor::text||':'||v::text;
  end if;
  if p.source='team' then
    select version into v from public.outreach_memberships where client_id=p.client_id and user_id=p_actor;
    return 'team:'||p_actor::text||':'||v::text;
  end if;
  if r='agency_owner' then select version into v from public.outreach_agency_memberships where user_id=p_actor;
  else select version into v from public.outreach_memberships where client_id=p.client_id and user_id=p_actor; end if;
  -- Preserve existing external session stamps; linking to a member changes the stamp.
  return r||':'||v::text;
end; $$;
revoke all on function outreach_private.person_connection_authority(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function outreach_private.person_session_current(p_person uuid,p_actor uuid,p_stamp text) returns boolean
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select coalesce(outreach_private.person_can_connect(p_person,p_actor) and p_stamp=(select
    case when p.source='team' and outreach_private.uses_covora_owner_access(p.client_id,p_actor) then 'covora_owner:'||p_actor::text||':'||a.version::text
      when p.source='team' then 'team:'||p_actor::text||':'||m.version::text
      when a.state='active' then 'agency_owner:'||a.version::text
      else m.role||':'||m.version::text end
    from public.outreach_people p
    left join public.outreach_memberships m on m.client_id=p.client_id and m.user_id=p_actor
    left join public.outreach_agency_memberships a on a.user_id=p_actor
    where p.id=p_person),false);
$$;
revoke all on function outreach_private.person_session_current(uuid,uuid,text) from public,anon,authenticated,service_role;

create or replace function public.list_outreach_people(p_client uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if not outreach_private.can_read(p_client) then raise exception using errcode='42501',message='People unavailable'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'email',p.email,
    'source',p.source,'agencyOwner',outreach_private.is_covora_owner(p.client_id,p.user_id),'isSelf',coalesce(p.user_id=auth.uid(),false),
    'role',coalesce((select role from public.outreach_memberships where client_id=p.client_id and user_id=p.user_id),case when outreach_private.is_covora_owner(p.client_id,p.user_id) then 'client_member' end),
    'access',case when outreach_private.is_covora_owner(p.client_id,p.user_id) then 'active' when p.source='external' then null else coalesce((select state from public.outreach_memberships where client_id=p.client_id and user_id=p.user_id),'revoked') end,
    'canConnect',outreach_private.person_can_connect(p.id,auth.uid()),
    'connections',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'channel',c.channel,
      'state',case when c.state in ('starting','pending') and not outreach_private.person_session_current(p.id,c.actor_id,c.authority_stamp) then 'needs_review'
        when c.state in ('starting','pending') and c.lease_until<now() then 'uncertain'
        when c.state in ('starting','pending') and c.expires_at<now() then 'expired'
        when c.state='connected' and not (case when c.channel='email' then exists(select 1 from public.outreach_account_workspaces w join public.outreach_accounts a on a.client_id=w.client_id where w.client_id=c.client_id and w.enabled and w.version=c.workspace_version and a.email=c.expected_email and a.state='connected')
          else exists(select 1 from public.outreach_reply_workspaces w where w.client_id=c.client_id and w.channel='linkedin' and w.enabled and w.version=c.workspace_version) end) then 'needs_review'
        else c.state end,
      'address',case when c.channel='email' then c.expected_email else coalesce((select sender_address from public.outreach_reply_senders where client_id=c.client_id and channel='linkedin' and remote_sender_id=c.remote_account),c.expected_profile_url,c.expected_email) end,
      'loginEmail',case when c.channel='linkedin' then c.expected_email else null end,
      'canCancel',c.channel='linkedin' and outreach_private.person_can_connect(p.id,auth.uid()) and outreach_private.person_can_disconnect(p.id,auth.uid())
        and (c.state in ('starting','pending','failed','expired','uncertain') and c.remote_account is not null
          or c.state in ('disconnecting','disconnect_uncertain') and c.disconnect_from_state is not null and c.disconnect_from_state<>'connected'),
      'canDisconnect',outreach_private.person_can_disconnect(p.id,auth.uid()) and c.state in ('connected','disconnecting','disconnect_uncertain'),
      'canContinue',c.actor_id=auth.uid() and outreach_private.person_session_current(p.id,c.actor_id,c.authority_stamp),'updatedAt',c.updated_at)) from
      (select distinct on(channel) * from public.outreach_connections where person_id=p.id order by channel,created_at desc,id desc) c),'[]'::jsonb)) order by p.created_at,p.id)
    from public.outreach_people p where p.client_id=p_client and (outreach_private.workspace_role(p_client) in ('agency_owner','client_admin','operator') or p.user_id=auth.uid())),'[]'::jsonb);
end; $$;

-- Existing verified owners use the same identity-linking rules as new members.
-- Linked person IDs, display names and connection history are preserved.
do $$ declare x record; begin
 for x in select c.id,a.user_id from public.clients c cross join public.outreach_agency_memberships a
   where c.slug='covora' and a.state='active' loop
   perform outreach_private.sync_member_person(x.id,x.user_id);
 end loop;
end $$;
notify pgrst,'reload schema';
