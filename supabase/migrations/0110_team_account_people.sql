-- Team membership owns portal identity; an account person owns sending identities.
-- Never infer agency membership in every client or merge different email addresses.
alter table public.outreach_people
  add column user_id uuid references auth.users(id) on delete set null,
  add column source text not null default 'external' check (source in ('external','team')),
  add constraint outreach_people_client_user_key unique(client_id,user_id);

create function outreach_private.sync_member_person(p_client uuid,p_user uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare address text; display text;
begin
  if not exists(select 1 from public.outreach_memberships where client_id=p_client and user_id=p_user
    and state='active' and role in ('client_admin','client_member','client_viewer')) then return; end if;
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

create function outreach_private.membership_person_changed() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  perform outreach_private.sync_member_person(new.client_id,new.user_id);
  return new;
end; $$;
revoke all on function outreach_private.membership_person_changed() from public,anon,authenticated,service_role;
create trigger outreach_membership_person after insert or update on public.outreach_memberships
  for each row execute function outreach_private.membership_person_changed();

create function outreach_private.confirmed_member_person() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare m record;
begin
  for m in select client_id from public.outreach_memberships where user_id=new.id loop
    perform outreach_private.sync_member_person(m.client_id,new.id);
  end loop;
  return new;
end; $$;
revoke all on function outreach_private.confirmed_member_person() from public,anon,authenticated,service_role;
create trigger outreach_confirmed_member_person after update of email_confirmed_at on auth.users
  for each row when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function outreach_private.confirmed_member_person();

do $$ declare m record; begin
  for m in select client_id,user_id from public.outreach_memberships where state='active' loop
    perform outreach_private.sync_member_person(m.client_id,m.user_id);
  end loop;
end $$;

-- Status and controls are derived server-side, with the same rule used at dispatch.
create function outreach_private.person_can_connect(p_person uuid,p_actor uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select coalesce((select case when p.source='team' then p.user_id=p_actor and exists(
    select 1 from public.outreach_memberships m where m.client_id=p.client_id and m.user_id=p_actor
      and m.state='active' and m.role in ('client_admin','client_member'))
    else exists(select 1 from public.outreach_agency_memberships where user_id=p_actor and state='active')
      or exists(select 1 from public.outreach_memberships where client_id=p.client_id and user_id=p_actor
        and state='active' and role in ('client_admin','operator')) end
    from public.outreach_people p where p.id=p_person),false);
$$;
revoke all on function outreach_private.person_can_connect(uuid,uuid) from public,anon,authenticated,service_role;

create function outreach_private.person_connection_authority(p_person uuid,p_actor uuid) returns text
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare p public.outreach_people%rowtype; r text; v bigint;
begin
  select * into p from public.outreach_people where id=p_person;
  if not found then raise insufficient_privilege; end if;
  perform outreach_private.lock_team_workspace(p.client_id);
  r:=outreach_private.lock_team_role(p.client_id,p_actor);
  select * into p from public.outreach_people where id=p_person for share;
  if r is null or not outreach_private.person_can_connect(p_person,p_actor) then raise insufficient_privilege; end if;
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

create or replace function public.prepare_outreach_connection(p_person uuid,p_channel text,p_action text,p_email text default null)
returns table(connection_id uuid,claim_token uuid)
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare person public.outreach_people%rowtype; c public.outreach_connections%rowtype; stamp text; w jsonb; address text; lease uuid;
begin
  select * into person from public.outreach_people where id=p_person;
  if not found then raise exception using errcode='42501',message='Person unavailable'; end if;
  stamp:=outreach_private.person_connection_authority(p_person,auth.uid());
  if p_channel is null or p_channel not in ('email','linkedin') or p_action is null or p_action not in ('start','poll','pin') or (p_action='pin' and p_channel<>'linkedin') then raise invalid_parameter_value; end if;
  w:=outreach_private.connection_workspace(person.client_id,p_channel);
  select * into c from public.outreach_connections where person_id=p_person and channel=p_channel order by created_at desc,id desc limit 1 for update;
  if c.id is not null and c.state in ('starting','pending') then
    if c.lease_until<clock_timestamp() then
      -- Never repeat a potentially consumed OAuth result or a lost Connect call.
      update public.outreach_connections set state='uncertain',lease_id=null,lease_until=null,auth_url=null where id=c.id;
      c.state:='uncertain';
    elsif c.expires_at<=clock_timestamp() and c.lease_id is null then
      update public.outreach_connections set state='expired',auth_url=null where id=c.id;
      c.state:='expired';
    end if;
  end if;
  if p_action='start' and (c.id is null or c.state in ('failed','expired')) then
    if c.created_at>clock_timestamp()-interval '30 seconds' then raise invalid_parameter_value; end if;
    address:=case when p_channel='email' then person.email else outreach_private.account_email(p_email) end;
    if address is null or length(address)>254 or address !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise invalid_parameter_value; end if;
    if p_channel='email' then
      if split_part(address,'@',2) in ('gmail.com','googlemail.com') then raise invalid_parameter_value; end if;
      perform pg_advisory_xact_lock(hashtextextended(address,913));
      if exists(select 1 from public.outreach_accounts where email=address and client_id<>person.client_id) then raise invalid_parameter_value; end if;
      insert into public.outreach_accounts(client_id,email,display_name,created_by) values(person.client_id,address,person.name,auth.uid()) on conflict(email) do nothing;
    end if;
    insert into public.outreach_connection_reservations(channel,email,person_id) values(p_channel,address,p_person) on conflict do nothing;
    if not exists(select 1 from public.outreach_connection_reservations where channel=p_channel and email=address and person_id=p_person) then raise invalid_parameter_value; end if;
    lease:=gen_random_uuid();
    insert into public.outreach_connections(person_id,client_id,channel,expected_email,actor_id,authority_stamp,workspace_version,state,lease_id,lease_until)
      values(p_person,person.client_id,p_channel,address,auth.uid(),stamp,(w->>'version')::bigint,'starting',lease,clock_timestamp()+interval '45 seconds') returning * into c;
    insert into public.outreach_onboarding_audit(client_id,actor_id,subject_id,event) values(person.client_id,auth.uid(),c.id,'connection_started');
    return query select c.id,lease; return;
  end if;
  if c.id is null then raise invalid_parameter_value; end if;
  -- Other workspace admins can see progress, but cannot consume another person's login session.
  if c.actor_id<>auth.uid() or c.authority_stamp<>stamp or c.workspace_version<>(w->>'version')::bigint then
    raise exception using errcode='42501',message='Session unavailable'; end if;
  if p_action='start' or c.state<>'pending' or c.lease_id is not null or c.next_poll_at>clock_timestamp() then
    return query select c.id,null::uuid; return;
  end if;
  lease:=gen_random_uuid();
  update public.outreach_connections set lease_id=lease,lease_until=clock_timestamp()+interval '45 seconds' where id=c.id;
  return query select c.id,lease;
exception when unique_violation then raise exception using errcode='22023',message='Account unavailable';
end; $$;

create or replace function public.read_outreach_connection(p_id uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_connections%rowtype; stamp text; w jsonb;
begin
  select * into c from public.outreach_connections where id=p_id;
  if not found then return null; end if;
  stamp:=outreach_private.person_connection_authority(c.person_id,c.actor_id);
  w:=outreach_private.connection_workspace(c.client_id,c.channel);
  if c.authority_stamp<>stamp or c.workspace_version<>(w->>'version')::bigint or c.lease_id is distinct from p_lease
    or p_lease is null or c.lease_until<=clock_timestamp() or c.expires_at<=clock_timestamp() then return null; end if;
  return w||jsonb_build_object('channel',c.channel,'email',c.expected_email,'remoteSession',c.remote_session,'remoteAccount',c.remote_account);
end; $$;

create or replace function public.finish_outreach_connection(p_id uuid,p_lease uuid,p_state text,p_remote_session text default null,p_remote_account text default null,p_auth_url text default null,p_address text default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_connections%rowtype; w jsonb; stamp text; person public.outreach_people%rowtype;
begin
  if p_state is null or p_state not in ('pending','connected','failed','expired','uncertain') then raise invalid_parameter_value; end if;
  select * into c from public.outreach_connections where id=p_id;
  if not found then return false; end if;
  stamp:=outreach_private.person_connection_authority(c.person_id,c.actor_id);
  w:=outreach_private.connection_workspace(c.client_id,c.channel);
  select * into c from public.outreach_connections where id=p_id for update;
  if c.authority_stamp<>stamp or c.workspace_version<>(w->>'version')::bigint or p_lease is null or c.lease_id is distinct from p_lease
    or c.lease_until<=clock_timestamp() or c.expires_at<=clock_timestamp() then return false; end if;
  if p_auth_url is not null and (c.channel<>'email' or p_auth_url !~ '^https://accounts\.google\.com/') then raise invalid_parameter_value; end if;
  if p_state='connected' then
    select * into person from public.outreach_people where id=c.person_id;
    if c.channel='email' then
      if p_remote_account is distinct from c.expected_email then raise invalid_parameter_value; end if;
      update public.outreach_accounts set state='connected',last_checked_at=clock_timestamp(),last_connected_at=clock_timestamp(),check_error=false,updated_at=clock_timestamp()
        where client_id=c.client_id and email=c.expected_email;
    else
      if p_remote_account is null or p_remote_account !~ '^[1-9][0-9]{0,15}$' or p_remote_account is distinct from c.remote_account or p_address is null or p_address !~ '^https://(www\.)?linkedin\.com/in/' then raise invalid_parameter_value; end if;
      if exists(select 1 from public.outreach_reply_senders where channel='linkedin' and remote_sender_id=p_remote_account and client_id<>c.client_id) then raise invalid_parameter_value; end if;
      if exists(select 1 from public.outreach_connections where channel='linkedin' and remote_account=p_remote_account and person_id<>c.person_id and state='connected') then raise invalid_parameter_value; end if;
      insert into public.outreach_reply_senders(client_id,channel,workspace_id,remote_sender_id,sender_address,sender_label,enabled)
        values(c.client_id,'linkedin',(w->>'binding')::uuid,p_remote_account,p_address,person.name,false) on conflict(channel,remote_sender_id) do nothing;
    end if;
  end if;
  update public.outreach_connections set state=p_state,remote_session=coalesce(p_remote_session,remote_session),remote_account=coalesce(p_remote_account,remote_account),
    auth_url=case when p_state='pending' then coalesce(p_auth_url,auth_url) else null end,
    lease_id=null,lease_until=null,next_poll_at=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp() where id=p_id;
  if p_state<>'pending' then insert into public.outreach_onboarding_audit(client_id,actor_id,subject_id,event) values(c.client_id,c.actor_id,c.id,'connection_finished'); end if;
  return true;
exception when insufficient_privilege then return false;
end; $$;

create or replace function public.list_outreach_people(p_client uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if not outreach_private.can_read(p_client) then raise exception using errcode='42501',message='People unavailable'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'email',p.email,
    'source',p.source,'isSelf',coalesce(p.user_id=auth.uid(),false),
    'role',(select role from public.outreach_memberships where client_id=p.client_id and user_id=p.user_id),
    'access',case when p.source='external' then null else coalesce((select state from public.outreach_memberships where client_id=p.client_id and user_id=p.user_id),'revoked') end,
    'canConnect',outreach_private.person_can_connect(p.id,auth.uid()),
    'connections',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'channel',c.channel,
      'state',case when c.state in ('starting','pending') and c.lease_until<now() then 'uncertain'
        when c.state in ('starting','pending') and c.expires_at<now() then 'expired'
        when c.state='connected' and not (case when c.channel='email' then exists(select 1 from public.outreach_account_workspaces w join public.outreach_accounts a on a.client_id=w.client_id where w.client_id=c.client_id and w.enabled and w.version=c.workspace_version and a.email=c.expected_email and a.state='connected')
          else exists(select 1 from public.outreach_reply_workspaces w where w.client_id=c.client_id and w.channel='linkedin' and w.enabled and w.version=c.workspace_version) end) then 'needs_review'
        else c.state end,
      'canContinue',c.actor_id=auth.uid() and outreach_private.person_can_connect(p.id,auth.uid()),'updatedAt',c.updated_at)) from
      (select distinct on(channel) * from public.outreach_connections where person_id=p.id order by channel,created_at desc,id desc) c),'[]'::jsonb)) order by p.created_at,p.id)
    from public.outreach_people p where p.client_id=p_client and (outreach_private.workspace_role(p_client) in ('agency_owner','client_admin','operator') or p.user_id=auth.uid())),'[]'::jsonb);
end; $$;

notify pgrst,'reload schema';
