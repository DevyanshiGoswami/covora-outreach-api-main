-- Recover a failed LinkedIn observation only after checking its exact existing sender.
-- Identity reservations and the original login stay intact; no new login is started.
create or replace function public.prepare_outreach_linkedin_review(p_person uuid)
returns table(connection_id uuid,claim_token uuid)
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare person public.outreach_people%rowtype; c public.outreach_connections%rowtype; stamp text; w jsonb; lease uuid;
begin
  select * into person from public.outreach_people where id=p_person;
  if not found then raise insufficient_privilege; end if;
  stamp:=outreach_private.person_connection_authority(p_person,auth.uid());
  w:=outreach_private.connection_workspace(person.client_id,'linkedin');
  select * into c from public.outreach_connections where person_id=p_person and channel='linkedin' order by created_at desc,id desc limit 1 for update;
  if c.id is null then raise invalid_parameter_value; end if;
  if c.workspace_version<>(w->>'version')::bigint then raise insufficient_privilege; end if;
  -- A request that died holding its lease is the same unknown outcome as a lost reply.
  if c.state in ('starting','pending') and c.lease_id is not null and c.lease_until<clock_timestamp() then
    update public.outreach_connections set state='uncertain',lease_id=null,lease_until=null where id=c.id;
    c.state:='uncertain'; c.lease_id:=null;
  end if;
  if c.state not in ('uncertain','failed') or (c.state='failed' and c.remote_account is null) or (c.lease_id is not null and c.lease_until>clock_timestamp()) or c.next_poll_at>clock_timestamp() then
    return query select c.id,null::uuid; return;
  end if;
  if not exists(select 1 from public.outreach_connection_reservations where person_id=c.person_id and channel='linkedin' and email=c.expected_email) then raise insufficient_privilege; end if;
  lease:=gen_random_uuid();
  update public.outreach_connections set actor_id=auth.uid(),authority_stamp=stamp,workspace_version=(w->>'version')::bigint,
    lease_id=lease,lease_until=clock_timestamp()+interval '45 seconds',next_poll_at=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp()
    where id=c.id;
  return query select c.id,lease;
end; $$;
revoke all on function public.prepare_outreach_linkedin_review(uuid) from public,anon,authenticated,service_role;
grant execute on function public.prepare_outreach_linkedin_review(uuid) to authenticated;

create or replace function public.read_outreach_linkedin_review(p_id uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_connections%rowtype; stamp text; w jsonb;
begin
  select * into c from public.outreach_connections where id=p_id;
  if not found or c.channel<>'linkedin' or c.state not in ('uncertain','failed') then return null; end if;
  stamp:=outreach_private.person_connection_authority(c.person_id,c.actor_id);
  w:=outreach_private.connection_workspace(c.client_id,'linkedin');
  if c.authority_stamp<>stamp or c.workspace_version<>(w->>'version')::bigint
    or p_lease is null or c.lease_id is distinct from p_lease or c.lease_until<=clock_timestamp() then return null; end if;
  return w||jsonb_build_object('channel','linkedin','email',c.expected_email,'remoteSession',null,'remoteAccount',c.remote_account,'expectedProfileUrl',c.expected_profile_url);
end; $$;
revoke all on function public.read_outreach_linkedin_review(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_outreach_linkedin_review(uuid,uuid) to service_role;

-- restore: the attempt returns to normal status checks with its sender; missing: expires once its
-- sign-in window has passed (as email does); unavailable: preserves failed/uncertain
-- state and its reservation so it can be checked again without another login.
create or replace function public.finish_outreach_linkedin_review(p_id uuid,p_lease uuid,p_outcome text,p_remote_account text default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_connections%rowtype; stamp text; w jsonb; next_state text; sender text;
begin
  if p_outcome is null or p_outcome not in ('restore','missing','unavailable') then raise invalid_parameter_value; end if;
  select * into c from public.outreach_connections where id=p_id;
  if not found or c.channel<>'linkedin' then return false; end if;
  stamp:=outreach_private.person_connection_authority(c.person_id,c.actor_id);
  w:=outreach_private.connection_workspace(c.client_id,'linkedin');
  select * into c from public.outreach_connections where id=p_id for update;
  if c.state not in ('uncertain','failed') or c.authority_stamp<>stamp or c.workspace_version<>(w->>'version')::bigint
    or p_lease is null or c.lease_id is distinct from p_lease or c.lease_until<=clock_timestamp() then return false; end if;
  if p_outcome='restore' then
    sender:=coalesce(c.remote_account,p_remote_account);
    if sender is null or sender !~ '^[1-9][0-9]{0,15}$' or (c.remote_account is not null and p_remote_account is distinct from c.remote_account and p_remote_account is not null) then
      raise invalid_parameter_value; end if;
    -- A sender already tied to another live attempt or connection is never adopted.
    if exists(select 1 from public.outreach_connections where channel='linkedin' and remote_account=sender and id<>c.id
      and state in ('starting','pending','connected','uncertain','disconnecting','disconnect_uncertain')) then raise invalid_parameter_value; end if;
    update public.outreach_connections set state='pending',remote_account=sender,expires_at=greatest(expires_at,clock_timestamp()+interval '10 minutes'),
      lease_id=null,lease_until=null,next_poll_at=clock_timestamp(),updated_at=clock_timestamp() where id=c.id;
    return true;
  end if;
  next_state:=case when c.state='failed' then 'failed' when p_outcome='missing' and c.expires_at<=clock_timestamp() then 'expired' else 'uncertain' end;
  update public.outreach_connections set state=next_state,lease_id=null,lease_until=null,next_poll_at=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp()
    where id=c.id;
  if next_state='expired' then
    insert into public.outreach_onboarding_audit(client_id,actor_id,subject_id,event) values(c.client_id,c.actor_id,c.id,'connection_finished');
  end if;
  return true;
exception when insufficient_privilege then return false;
end; $$;
revoke all on function public.finish_outreach_linkedin_review(uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_outreach_linkedin_review(uuid,uuid,text,text) to service_role;


-- Do not let a fresh login race the review of an older failed observation.
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
  -- Recovery owns this failed attempt until its status check finishes.
  if c.state='failed' and c.lease_id is not null and c.lease_until>clock_timestamp() then
    raise exception using errcode='22023',message='Connection check in progress'; end if;
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
  if p_action='start' or c.state<>'pending' or c.lease_id is not null or (p_action='poll' and c.next_poll_at>clock_timestamp()) then
    return query select c.id,null::uuid; return;
  end if;
  lease:=gen_random_uuid();
  update public.outreach_connections set lease_id=lease,lease_until=clock_timestamp()+interval '45 seconds' where id=c.id;
  return query select c.id,lease;
exception when unique_violation then raise exception using errcode='22023',message='Connection identity reserved';
end; $$;
