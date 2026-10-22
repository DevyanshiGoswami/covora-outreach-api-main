-- Disconnect a single confirmed sender, retaining its audit/conversation history.
alter table public.outreach_connections drop constraint outreach_connections_state_check;
alter table public.outreach_connections add constraint outreach_connections_state_check check(state in
  ('starting','pending','connected','failed','expired','uncertain','disconnecting','disconnect_uncertain','disconnected'));
drop index public.outreach_connection_active;
create unique index outreach_connection_active on public.outreach_connections(person_id,channel)
  where state in ('starting','pending','connected','uncertain','disconnecting','disconnect_uncertain');
drop index public.outreach_connection_verified_identity;
create unique index outreach_connection_verified_identity on public.outreach_connections(channel,remote_account)
  where state in ('connected','disconnecting','disconnect_uncertain');
alter table public.outreach_onboarding_audit drop constraint outreach_onboarding_audit_event_check;
alter table public.outreach_onboarding_audit add constraint outreach_onboarding_audit_event_check check(event in
  ('client_created','person_created','workspace_bound','connection_started','connection_finished','client_removed','disconnect_started','disconnect_finished'));
alter table public.outreach_provider_calls drop constraint outreach_provider_calls_method_check;
alter table public.outreach_provider_calls add constraint outreach_provider_calls_method_check check(method in ('GET','POST','DELETE'));
alter table public.outreach_provider_calls drop constraint outreach_provider_calls_source_check;
alter table public.outreach_provider_calls add constraint outreach_provider_calls_source_check check(source in ('connection','email_review','integration_check','probe','disconnect'));

create function outreach_private.person_can_disconnect(p_person uuid,p_actor uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select coalesce((select exists(select 1 from public.outreach_agency_memberships where user_id=p_actor and state='active')
    or exists(select 1 from public.outreach_memberships where client_id=p.client_id and user_id=p_actor and state='active'
      and (role='client_admin' or (role='client_member' and p.user_id=p_actor))) from public.outreach_people p where p.id=p_person and not outreach_private.workspace_is_preview(p.client_id)),false);
$$;
revoke all on function outreach_private.person_can_disconnect(uuid,uuid) from public,anon,authenticated,service_role;

create function outreach_private.disconnect_authority(p_person uuid,p_actor uuid) returns text
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare p public.outreach_people%rowtype; r text; v bigint;
begin
  select * into p from public.outreach_people where id=p_person;
  if not found then raise insufficient_privilege; end if;
  perform outreach_private.lock_team_workspace(p.client_id);
  if outreach_private.workspace_is_preview(p.client_id) then raise insufficient_privilege; end if;
  r:=outreach_private.lock_team_role(p.client_id,p_actor);
  if r is null or not outreach_private.person_can_disconnect(p_person,p_actor) then raise insufficient_privilege; end if;
  if r='agency_owner' then select version into v from public.outreach_agency_memberships where user_id=p_actor;
  else select version into v from public.outreach_memberships where client_id=p.client_id and user_id=p_actor; end if;
  return r||':'||p_actor::text||':'||v::text;
end; $$;
revoke all on function outreach_private.disconnect_authority(uuid,uuid) from public,anon,authenticated,service_role;

create function public.prepare_outreach_disconnect(p_connection uuid,p_action text)
returns table(connection_id uuid,claim_token uuid,perform_delete boolean)
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_connections%rowtype; stamp text; w jsonb; lease uuid; deleting boolean;
begin
  select * into c from public.outreach_connections where id=p_connection;
  if not found then raise insufficient_privilege; end if;
  stamp:=outreach_private.disconnect_authority(c.person_id,auth.uid());
  if p_action is null or p_action not in ('disconnect','check') then raise invalid_parameter_value; end if;
  w:=outreach_private.connection_workspace(c.client_id,c.channel);
  select * into c from public.outreach_connections where id=p_connection for update;
  if c.workspace_version<>(w->>'version')::bigint then raise insufficient_privilege; end if;
  if c.state='disconnected' then return query select c.id,null::uuid,false; return; end if;
  if c.state not in ('connected','disconnecting','disconnect_uncertain') or c.remote_account is null then raise invalid_parameter_value; end if;
  if c.lease_id is not null and c.lease_until>clock_timestamp() then return query select c.id,null::uuid,false; return; end if;
  -- Hold the sender identity across requests; another client/person must never be affected.
  if not exists(select 1 from public.outreach_connection_reservations where person_id=c.person_id and channel=c.channel and email=c.expected_email)
    or exists(select 1 from public.outreach_connections where id<>c.id and person_id<>c.person_id and channel=c.channel and remote_account=c.remote_account and state<>'disconnected')
    or exists(select 1 from public.outreach_reply_senders where channel=c.channel and remote_sender_id=c.remote_account and client_id<>c.client_id) then raise insufficient_privilege; end if;
  if exists(select 1 from public.outreach_reply_commands q join public.outreach_reply_senders s on s.id=q.sender_id
    where s.client_id=c.client_id and s.channel=c.channel and (s.remote_sender_id=c.remote_account or s.sender_address=c.expected_email)
      and q.status in ('queued','preparing','sending','unknown')) then
    raise exception using errcode='22023',message='Account has a pending reply'; end if;
  deleting:=c.state='connected' and p_action='disconnect';
  if c.state='connected' and not deleting then return query select c.id,null::uuid,false; return; end if;
  -- No second DELETE after a crash/timeout, including repeated Disconnect submissions.
  lease:=gen_random_uuid();
  update public.outreach_connections set state=case when deleting then 'disconnecting' else 'disconnect_uncertain' end,
    actor_id=auth.uid(),authority_stamp=stamp,lease_id=lease,lease_until=clock_timestamp()+interval '45 seconds',
    auth_url=null,updated_at=clock_timestamp() where id=c.id;
  -- Fence new replies, and never silently resume sending on a failed removal.
  update public.outreach_reply_senders set enabled=false where client_id=c.client_id and channel=c.channel
    and (remote_sender_id=c.remote_account or sender_address=c.expected_email);
  insert into public.outreach_onboarding_audit(client_id,actor_id,subject_id,event) values(c.client_id,auth.uid(),c.id,'disconnect_started');
  return query select c.id,lease,deleting;
end; $$;
revoke all on function public.prepare_outreach_disconnect(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.prepare_outreach_disconnect(uuid,text) to authenticated;

create function public.read_outreach_disconnect(p_id uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_connections%rowtype; stamp text; w jsonb;
begin
  select * into c from public.outreach_connections where id=p_id;
  if not found or c.state not in ('disconnecting','disconnect_uncertain') then return null; end if;
  stamp:=outreach_private.disconnect_authority(c.person_id,c.actor_id);
  w:=outreach_private.connection_workspace(c.client_id,c.channel);
  if c.authority_stamp<>stamp or c.workspace_version<>(w->>'version')::bigint or p_lease is null
    or c.lease_id is distinct from p_lease or c.lease_until<=clock_timestamp() then return null; end if;
  return w||jsonb_build_object('channel',c.channel,'email',c.expected_email,'remoteSession',null,'remoteAccount',c.remote_account);
end; $$;
revoke all on function public.read_outreach_disconnect(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_outreach_disconnect(uuid,uuid) to service_role;

create function public.finish_outreach_disconnect(p_id uuid,p_lease uuid,p_outcome text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_connections%rowtype; w jsonb; stamp text;
begin
  if p_outcome is null or p_outcome not in ('removed','rejected','uncertain') then raise invalid_parameter_value; end if;
  select * into c from public.outreach_connections where id=p_id;
  if not found then return false; end if;
  stamp:=outreach_private.disconnect_authority(c.person_id,c.actor_id);
  w:=outreach_private.connection_workspace(c.client_id,c.channel);
  select * into c from public.outreach_connections where id=p_id for update;
  if c.state not in ('disconnecting','disconnect_uncertain') or c.authority_stamp<>stamp or c.workspace_version<>(w->>'version')::bigint
    or p_lease is null or c.lease_id is distinct from p_lease or c.lease_until<=clock_timestamp() then return false; end if;
  -- A read-only check cannot make an uncertain delete retryable.
  if c.state='disconnect_uncertain' and p_outcome='rejected' then raise invalid_parameter_value; end if;
  if p_outcome='removed' then
    delete from public.outreach_connection_reservations where person_id=c.person_id and channel=c.channel and email=c.expected_email;
    if c.channel='email' then
      update public.outreach_accounts set state='unverified',last_checked_at=null,last_connected_at=null,current_check_id=null,check_error=false,updated_at=clock_timestamp()
        where client_id=c.client_id and email=c.expected_email;
    end if;
  end if;
  update public.outreach_connections set state=case p_outcome when 'removed' then 'disconnected' when 'rejected' then 'connected' else 'disconnect_uncertain' end,
    lease_id=null,lease_until=null,auth_url=null,updated_at=clock_timestamp() where id=c.id;
  insert into public.outreach_onboarding_audit(client_id,actor_id,subject_id,event) values(c.client_id,c.actor_id,c.id,'disconnect_finished');
  return true;
exception when insufficient_privilege then return false;
end; $$;
revoke all on function public.finish_outreach_disconnect(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_outreach_disconnect(uuid,uuid,text) to service_role;

-- Permit correcting a login typo only when no attempt reached a remote account.
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
  if c.state in ('disconnecting','disconnect_uncertain') then raise exception using errcode='22023',message='Disconnection requires review'; end if;
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
  if p_action='start' and (c.id is null or c.state in ('failed','expired','disconnected')) then
    if c.state<>'disconnected' and c.created_at>clock_timestamp()-interval '30 seconds' then
      raise exception using errcode='22023',message='Connection retry too soon'; end if;
    address:=case when p_channel='email' then coalesce(outreach_private.account_email(p_email),person.email) else outreach_private.account_email(p_email) end;
    if address is null or length(address)>254 or address !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise invalid_parameter_value; end if;
    if p_channel='email' and exists(select 1 from public.outreach_connection_reservations where person_id=p_person and channel='email' and email<>address) then
      raise exception using errcode='22023',message='Disconnect the current mailbox before changing it'; end if;
    if p_channel='email' then
      if split_part(address,'@',2) in ('gmail.com','googlemail.com') then raise invalid_parameter_value; end if;
      perform pg_advisory_xact_lock(hashtextextended(address,913));
      if exists(select 1 from public.outreach_accounts where email=address and client_id<>person.client_id) then raise invalid_parameter_value; end if;
      insert into public.outreach_accounts(client_id,email,display_name,created_by) values(person.client_id,address,person.name,auth.uid()) on conflict(email) do nothing;
    end if;
    -- Correct an unused LinkedIn login reservation only after definite failures.
    -- Any remote identity, unfinished attempt or uncertainty keeps the original fence.
    if p_channel='linkedin' and exists(select 1 from public.outreach_connection_reservations
      where person_id=p_person and channel=p_channel and email<>address) then
      if not exists(select 1 from public.outreach_connections where person_id=p_person and channel=p_channel)
        or exists(select 1 from public.outreach_connections where person_id=p_person and channel=p_channel
          and state<>'disconnected' and (state<>'failed' or remote_account is not null or remote_session is not null or lease_id is not null)) then
        raise exception using errcode='22023',message='LinkedIn identity requires review';
      end if;
      -- The current person/workspace lock serializes their attempts. The primary
      -- key on (channel,email) still prevents adoption from any other person.
      update public.outreach_connection_reservations set email=address
        where person_id=p_person and channel=p_channel;
    end if;
    insert into public.outreach_connection_reservations(channel,email,person_id) values(p_channel,address,p_person) on conflict do nothing;
    if not exists(select 1 from public.outreach_connection_reservations where channel=p_channel and email=address and person_id=p_person) then
      raise exception using errcode='22023',message='Connection identity reserved'; end if;
    lease:=gen_random_uuid();
    insert into public.outreach_connections(person_id,client_id,channel,expected_email,actor_id,authority_stamp,workspace_version,state,lease_id,lease_until)
      values(p_person,person.client_id,p_channel,address,auth.uid(),stamp,(w->>'version')::bigint,'starting',lease,clock_timestamp()+interval '45 seconds') returning * into c;
    insert into public.outreach_onboarding_audit(client_id,actor_id,subject_id,event) values(person.client_id,auth.uid(),c.id,'connection_started');
    return query select c.id,lease; return;
  end if;
  if c.id is null then raise invalid_parameter_value; end if;
  if c.state='disconnected' then raise invalid_parameter_value; end if;
  -- Other workspace admins can see progress, but cannot consume another person's login session.
  if c.actor_id<>auth.uid() or c.authority_stamp<>stamp or c.workspace_version<>(w->>'version')::bigint then
    raise exception using errcode='42501',message='Session unavailable'; end if;
  if p_action='start' and p_channel='linkedin' and outreach_private.account_email(p_email) is distinct from c.expected_email then
    raise exception using errcode='22023',message='LinkedIn identity requires review'; end if;
  if p_action='start' or c.state<>'pending' or c.lease_id is not null or c.next_poll_at>clock_timestamp() then
    return query select c.id,null::uuid; return;
  end if;
  lease:=gen_random_uuid();
  update public.outreach_connections set lease_id=lease,lease_until=clock_timestamp()+interval '45 seconds' where id=c.id;
  return query select c.id,lease;
exception when unique_violation then raise exception using errcode='22023',message='Connection identity reserved';
end; $$;


-- A confirmed rejection before an email session was created has no consent
-- window to wait for. Unknown outcomes still retain their original deadline.
create or replace function public.prepare_outreach_email_review(p_person uuid)
returns table(connection_id uuid,claim_token uuid)
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare person public.outreach_people%rowtype; c public.outreach_connections%rowtype; stamp text; w jsonb; lease uuid;
begin
  select * into person from public.outreach_people where id=p_person;
  if not found then raise insufficient_privilege; end if;
  stamp:=outreach_private.person_connection_authority(p_person,auth.uid());
  w:=outreach_private.connection_workspace(person.client_id,'email');
  select * into c from public.outreach_connections where person_id=p_person and channel='email' order by created_at desc,id desc limit 1 for update;
  if c.id is null or c.state in ('disconnected','disconnecting','disconnect_uncertain') then raise invalid_parameter_value; end if;
  if (c.lease_id is not null and c.lease_until>clock_timestamp())
    or (c.state in ('starting','pending') and c.lease_id is null and c.expires_at>clock_timestamp())
    or c.next_poll_at>clock_timestamp() then
    return query select c.id,null::uuid; return;
  end if;
  lease:=gen_random_uuid();
  update public.outreach_connections set state='uncertain',actor_id=auth.uid(),authority_stamp=stamp,
    workspace_version=(w->>'version')::bigint,lease_id=lease,lease_until=clock_timestamp()+interval '45 seconds',
    expires_at=case when c.state='failed' and c.remote_session is null then least(c.expires_at,clock_timestamp()) else c.expires_at end,
    auth_url=null,next_poll_at=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp() where id=c.id;
  return query select c.id,lease;
end; $$;
revoke all on function public.prepare_outreach_email_review(uuid) from public,anon,authenticated,service_role;
grant execute on function public.prepare_outreach_email_review(uuid) to authenticated;

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
      'state',case when c.state in ('starting','pending') and not outreach_private.person_session_current(p.id,c.actor_id,c.authority_stamp) then 'needs_review'
        when c.state in ('starting','pending') and c.lease_until<now() then 'uncertain'
        when c.state in ('starting','pending') and c.expires_at<now() then 'expired'
        when c.state='connected' and not (case when c.channel='email' then exists(select 1 from public.outreach_account_workspaces w join public.outreach_accounts a on a.client_id=w.client_id where w.client_id=c.client_id and w.enabled and w.version=c.workspace_version and a.email=c.expected_email and a.state='connected')
          else exists(select 1 from public.outreach_reply_workspaces w where w.client_id=c.client_id and w.channel='linkedin' and w.enabled and w.version=c.workspace_version) end) then 'needs_review'
        else c.state end,
      'address',case when c.channel='email' then c.expected_email else coalesce((select sender_address from public.outreach_reply_senders where client_id=c.client_id and channel='linkedin' and remote_sender_id=c.remote_account),c.expected_profile_url,c.expected_email) end,
      'canDisconnect',outreach_private.person_can_disconnect(p.id,auth.uid()) and c.state in ('connected','disconnecting','disconnect_uncertain'),
      'canContinue',c.actor_id=auth.uid() and outreach_private.person_session_current(p.id,c.actor_id,c.authority_stamp),'updatedAt',c.updated_at)) from
      (select distinct on(channel) * from public.outreach_connections where person_id=p.id order by channel,created_at desc,id desc) c),'[]'::jsonb)) order by p.created_at,p.id)
    from public.outreach_people p where p.client_id=p_client and (outreach_private.workspace_role(p_client) in ('agency_owner','client_admin','operator') or p.user_id=auth.uid())),'[]'::jsonb);
end; $$;


create function outreach_private.guard_disconnected_sender() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if new.enabled and exists(select 1 from public.outreach_connections c where c.client_id=new.client_id and c.channel=new.channel
    and (c.remote_account=new.remote_sender_id or c.expected_email=new.sender_address)
    and c.state in ('disconnecting','disconnect_uncertain','disconnected')
    and not exists(select 1 from public.outreach_connections newer where newer.person_id=c.person_id and newer.channel=c.channel
      and newer.created_at>c.created_at and newer.state='connected' and newer.remote_account=c.remote_account)) then
    raise exception using errcode='22023',message='Account is disconnected or being disconnected'; end if;
  return new;
end; $$;
revoke all on function outreach_private.guard_disconnected_sender() from public,anon,authenticated,service_role;
create trigger outreach_sender_disconnect_guard before insert or update on public.outreach_reply_senders for each row execute function outreach_private.guard_disconnected_sender();
notify pgrst,'reload schema';

create or replace function public.read_outreach_connection(p_id uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_connections%rowtype; stamp text; w jsonb;
begin
  select * into c from public.outreach_connections where id=p_id;
  if not found or c.state not in ('starting','pending') then return null; end if;
  stamp:=outreach_private.person_connection_authority(c.person_id,c.actor_id);
  w:=outreach_private.connection_workspace(c.client_id,c.channel);
  if c.authority_stamp<>stamp or c.workspace_version<>(w->>'version')::bigint or c.lease_id is distinct from p_lease
    or p_lease is null or c.lease_until<=clock_timestamp() or c.expires_at<=clock_timestamp() then return null; end if;
  return w||jsonb_build_object('channel',c.channel,'email',c.expected_email,'remoteSession',c.remote_session,'remoteAccount',c.remote_account,'expectedProfileUrl',c.expected_profile_url);
end; $$;

create or replace function public.finish_outreach_connection(p_id uuid,p_lease uuid,p_state text,p_remote_session text default null,p_remote_account text default null,p_auth_url text default null,p_address text default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_connections%rowtype; w jsonb; stamp text; person public.outreach_people%rowtype;
begin
  if p_state is null or p_state not in ('pending','connected','failed','expired','uncertain') then raise invalid_parameter_value; end if;
  select * into c from public.outreach_connections where id=p_id;
  if not found or c.state not in ('starting','pending') then return false; end if;
  stamp:=outreach_private.person_connection_authority(c.person_id,c.actor_id);
  w:=outreach_private.connection_workspace(c.client_id,c.channel);
  select * into c from public.outreach_connections where id=p_id for update;
  if c.authority_stamp<>stamp or c.workspace_version<>(w->>'version')::bigint or p_lease is null or c.lease_id is distinct from p_lease
    or c.lease_until<=clock_timestamp() or c.expires_at<=clock_timestamp() then return false; end if;
  if p_auth_url is not null and (c.channel<>'email' or p_auth_url !~ '^https://(accounts\.google\.com|login\.microsoftonline\.com)/') then raise invalid_parameter_value; end if;
  if p_state='connected' then
    select * into person from public.outreach_people where id=c.person_id;
    if c.channel='email' then
      if p_remote_account is distinct from c.expected_email then raise invalid_parameter_value; end if;
      update public.outreach_accounts set state='connected',last_checked_at=clock_timestamp(),last_connected_at=clock_timestamp(),check_error=false,updated_at=clock_timestamp()
        where client_id=c.client_id and email=c.expected_email;
    else
      if c.expected_profile_url is not null and p_address is distinct from c.expected_profile_url then raise invalid_parameter_value; end if;
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

notify pgrst,'reload schema';
