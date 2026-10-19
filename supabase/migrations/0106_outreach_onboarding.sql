-- Portal onboarding. Provider sessions and identifiers are private; passwords,
-- PINs and API keys are never stored. Connections grant no campaign permissions.
create table public.outreach_people (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null check(length(btrim(name)) between 1 and 100),
  email text not null check(email=outreach_private.account_email(email) and length(email)<=254
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  created_at timestamptz not null default now(),
  unique(client_id,email), unique(id,client_id)
);
create table public.outreach_connections (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null, client_id uuid not null,
  channel text not null check(channel in ('email','linkedin')),
  expected_email text not null,
  actor_id uuid not null, authority_stamp text not null, workspace_version bigint not null,
  state text not null check(state in ('starting','pending','connected','failed','expired','uncertain')),
  remote_session text, remote_account text, auth_url text,
  lease_id uuid, lease_until timestamptz, next_poll_at timestamptz,
  expires_at timestamptz not null default now()+interval '10 minutes',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(person_id,client_id) references public.outreach_people(id,client_id) on delete cascade
);
create unique index outreach_connection_active on public.outreach_connections(person_id,channel)
  where state in ('starting','pending','connected','uncertain');
-- Reserve login identities before making an external call, including uncertain outcomes.
create table public.outreach_connection_reservations (
  channel text not null, email text not null, person_id uuid not null references public.outreach_people(id) on delete cascade,
  primary key(channel,email), unique(person_id,channel)
);
create table public.outreach_onboarding_audit (
  id bigint generated always as identity primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  actor_id uuid not null, subject_id uuid not null,
  event text not null check(event in ('client_created','person_created','workspace_bound','connection_started','connection_finished')),
  created_at timestamptz not null default now()
);
alter table public.outreach_people enable row level security;
alter table public.outreach_connections enable row level security;
alter table public.outreach_connection_reservations enable row level security;
alter table public.outreach_onboarding_audit enable row level security;
create policy onboarding_people_service on public.outreach_people for all to service_role using(true) with check(true);
create policy onboarding_connections_service on public.outreach_connections for all to service_role using(true) with check(true);
create policy onboarding_reservations_service on public.outreach_connection_reservations for all to service_role using(true) with check(true);
create policy onboarding_audit_service on public.outreach_onboarding_audit for select to service_role using(true);
revoke all on public.outreach_people,public.outreach_connections,public.outreach_connection_reservations,public.outreach_onboarding_audit from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.outreach_people,public.outreach_connections,public.outreach_connection_reservations to service_role;
grant select on public.outreach_onboarding_audit to service_role;

create function outreach_private.connection_authority(p_client uuid,p_actor uuid) returns text
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r text; v bigint;
begin
  perform outreach_private.lock_team_workspace(p_client);
  r:=outreach_private.lock_team_role(p_client,p_actor);
  if r is null or r not in ('agency_owner','client_admin','operator') then
    raise exception using errcode='42501',message='Connection access denied';
  end if;
  if r='agency_owner' then select version into v from public.outreach_agency_memberships where user_id=p_actor;
  else select version into v from public.outreach_memberships where user_id=p_actor and client_id=p_client; end if;
  return r||':'||v::text;
end; $$;
revoke all on function outreach_private.connection_authority(uuid,uuid) from public,anon,authenticated,service_role;

create function public.outreach_portal_context() returns jsonb
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select jsonb_build_object('userId',auth.uid(),'isOwner',exists(select 1 from public.outreach_agency_memberships where user_id=auth.uid() and state='active'),
    'workspaces',coalesce((select jsonb_agg(jsonb_build_object('id',client_id,'name',client_name,'role',role) order by client_name,client_id)
      from public.client_outreach_workspaces),'[]'::jsonb));
$$;
revoke all on function public.outreach_portal_context() from public,anon,authenticated,service_role;
grant execute on function public.outreach_portal_context() to authenticated;

create function public.create_outreach_client(p_id uuid,p_name text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  perform 1 from public.outreach_agency_memberships where user_id=auth.uid() and state='active' for share;
  if not found then raise exception using errcode='42501',message='Client creation denied'; end if;
  if p_id is null or p_name is null or length(btrim(p_name)) not between 1 and 100 then
    raise exception using errcode='22023',message='Invalid client'; end if;
  if exists(select 1 from public.clients where id=p_id) then return p_id; end if;
  insert into public.clients(id,slug,name) values(p_id,'outreach-'||p_id::text,btrim(p_name));
  insert into public.client_features(client_id,feature,enabled) values(p_id,'outreach_app',true);
  insert into public.outreach_onboarding_audit(client_id,actor_id,subject_id,event) values(p_id,auth.uid(),p_id,'client_created');
  return p_id;
end; $$;
revoke all on function public.create_outreach_client(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.create_outreach_client(uuid,text) to authenticated;

create function public.create_outreach_person(p_client_id uuid,p_name text,p_email text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare person uuid;
begin
  perform outreach_private.connection_authority(p_client_id,auth.uid());
  insert into public.outreach_people(client_id,name,email) values(p_client_id,btrim(p_name),outreach_private.account_email(p_email))
    on conflict(client_id,email) do update set name=outreach_people.name returning id into person;
  insert into public.outreach_onboarding_audit(client_id,actor_id,subject_id,event) values(p_client_id,auth.uid(),person,'person_created');
  return person;
exception when check_violation or not_null_violation then raise exception using errcode='22023',message='Invalid person';
end; $$;
revoke all on function public.create_outreach_person(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.create_outreach_person(uuid,text,text) to authenticated;

-- Only the backend resolves a deployment-defined workspace alias into these
-- arguments. This RPC rechecks the actor; changing an existing binding is manual.
create function public.bind_outreach_connection_workspace(p_actor uuid,p_client uuid,p_channel text,p_workspace text,p_credential text) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare stamp text;
begin
  stamp:=outreach_private.connection_authority(p_client,p_actor);
  if stamp not like 'agency_owner:%' then raise exception using errcode='42501',message='Configuration denied'; end if;
  if p_channel='email' then
    if p_credential !~ '^OUTREACH_INSTANTLY_[A-Z0-9_]{1,100}$' then raise invalid_parameter_value; end if;
    insert into public.outreach_account_workspaces(client_id,remote_workspace_id,credential_ref,enabled)
      values(p_client,p_workspace::uuid,p_credential,true) on conflict(client_id) do nothing;
    if not exists(select 1 from public.outreach_account_workspaces where client_id=p_client and remote_workspace_id=p_workspace::uuid and credential_ref=p_credential and enabled) then
      raise exception using errcode='22023',message='Binding requires manual review'; end if;
  elsif p_channel='linkedin' then
    if p_credential !~ '^OUTREACH_HEYREACH_[A-Z0-9_]{1,100}$' then raise invalid_parameter_value; end if;
    insert into public.outreach_reply_workspaces(client_id,channel,remote_workspace_id,credential_ref,enabled,sync_enabled)
      values(p_client,'linkedin',p_workspace,p_credential,true,false) on conflict(client_id,channel) do nothing;
    if not exists(select 1 from public.outreach_reply_workspaces where client_id=p_client and channel='linkedin' and remote_workspace_id=p_workspace and credential_ref=p_credential and enabled) then
      raise exception using errcode='22023',message='Binding requires manual review'; end if;
  else raise invalid_parameter_value; end if;
  insert into public.outreach_onboarding_audit(client_id,actor_id,subject_id,event) values(p_client,p_actor,p_client,'workspace_bound');
exception when unique_violation then raise exception using errcode='22023',message='Workspace unavailable';
end; $$;
revoke all on function public.bind_outreach_connection_workspace(uuid,uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.bind_outreach_connection_workspace(uuid,uuid,text,text,text) to service_role;

create function outreach_private.connection_workspace(p_client uuid,p_channel text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare result jsonb;
begin
  if p_channel='email' then
    select jsonb_build_object('version',version,'credential',credential_ref,'workspace',remote_workspace_id::text)
      into result from public.outreach_account_workspaces where client_id=p_client and enabled for share;
  elsif p_channel='linkedin' then
    select jsonb_build_object('version',version,'credential',credential_ref,'workspace',remote_workspace_id,'binding',id)
      into result from public.outreach_reply_workspaces where client_id=p_client and channel='linkedin' and enabled for share;
  end if;
  if result is null then raise exception using errcode='42501',message='Connection workspace unavailable'; end if;
  return result;
end; $$;
revoke all on function outreach_private.connection_workspace(uuid,text) from public,anon,authenticated,service_role;

create function public.prepare_outreach_connection(p_person uuid,p_channel text,p_action text,p_email text default null)
returns table(connection_id uuid,claim_token uuid)
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare person public.outreach_people%rowtype; c public.outreach_connections%rowtype; stamp text; w jsonb; address text; lease uuid;
begin
  select * into person from public.outreach_people where id=p_person;
  if not found then raise exception using errcode='42501',message='Person unavailable'; end if;
  stamp:=outreach_private.connection_authority(person.client_id,auth.uid());
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
revoke all on function public.prepare_outreach_connection(uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.prepare_outreach_connection(uuid,text,text,text) to authenticated;

create function public.read_outreach_connection(p_id uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_connections%rowtype; stamp text; w jsonb;
begin
  select * into c from public.outreach_connections where id=p_id;
  if not found then return null; end if;
  stamp:=outreach_private.connection_authority(c.client_id,c.actor_id);
  w:=outreach_private.connection_workspace(c.client_id,c.channel);
  if c.authority_stamp<>stamp or c.workspace_version<>(w->>'version')::bigint or c.lease_id is distinct from p_lease
    or p_lease is null or c.lease_until<=clock_timestamp() or c.expires_at<=clock_timestamp() then return null; end if;
  return w||jsonb_build_object('channel',c.channel,'email',c.expected_email,'remoteSession',c.remote_session,'remoteAccount',c.remote_account);
end; $$;
revoke all on function public.read_outreach_connection(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_outreach_connection(uuid,uuid) to service_role;

create function public.finish_outreach_connection(p_id uuid,p_lease uuid,p_state text,p_remote_session text default null,p_remote_account text default null,p_auth_url text default null,p_address text default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_connections%rowtype; w jsonb; stamp text; person public.outreach_people%rowtype;
begin
  if p_state is null or p_state not in ('pending','connected','failed','expired','uncertain') then raise invalid_parameter_value; end if;
  select * into c from public.outreach_connections where id=p_id;
  if not found then return false; end if;
  stamp:=outreach_private.connection_authority(c.client_id,c.actor_id);
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
revoke all on function public.finish_outreach_connection(uuid,uuid,text,text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_outreach_connection(uuid,uuid,text,text,text,text,text) to service_role;

create function public.list_outreach_people(p_client uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if not outreach_private.can_read(p_client) then raise exception using errcode='42501',message='People unavailable'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'email',p.email,
    'connections',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'channel',c.channel,
      'state',case when c.state in ('starting','pending') and c.lease_until<now() then 'uncertain'
        when c.state in ('starting','pending') and c.expires_at<now() then 'expired'
        when c.state='connected' and not (case when c.channel='email' then exists(select 1 from public.outreach_account_workspaces w join public.outreach_accounts a on a.client_id=w.client_id where w.client_id=c.client_id and w.enabled and w.version=c.workspace_version and a.email=c.expected_email and a.state='connected')
          else exists(select 1 from public.outreach_reply_workspaces w where w.client_id=c.client_id and w.channel='linkedin' and w.enabled and w.version=c.workspace_version) end) then 'needs_review'
        else c.state end,
      'canContinue',c.actor_id=auth.uid(),'updatedAt',c.updated_at)) from
      (select distinct on(channel) * from public.outreach_connections where person_id=p.id order by channel,created_at desc,id desc) c),'[]'::jsonb)) order by p.created_at,p.id)
    from public.outreach_people p where p.client_id=p_client),'[]'::jsonb);
end; $$;
revoke all on function public.list_outreach_people(uuid) from public,anon,authenticated,service_role;
grant execute on function public.list_outreach_people(uuid) to authenticated;
notify pgrst,'reload schema';
