-- Recovery paths for connection attempts that end stuck or abandoned. Existing flows are unchanged.

-- LinkedIn senders that Covora itself created, so a failed or expired attempt can release its seat.
alter table public.outreach_connections add column remote_created boolean not null default false,
  add column remote_released_at timestamptz;

-- 1. "Check connection status" for a stuck (uncertain) LinkedIn attempt, mirroring the email review.
create function public.prepare_outreach_linkedin_review(p_person uuid)
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
  -- A request that died holding its lease is the same unknown outcome as a lost reply.
  if c.state in ('starting','pending') and c.lease_id is not null and c.lease_until<clock_timestamp() then
    update public.outreach_connections set state='uncertain',lease_id=null,lease_until=null where id=c.id;
    c.state:='uncertain'; c.lease_id:=null;
  end if;
  if c.state<>'uncertain' or (c.lease_id is not null and c.lease_until>clock_timestamp()) or c.next_poll_at>clock_timestamp() then
    return query select c.id,null::uuid; return;
  end if;
  lease:=gen_random_uuid();
  update public.outreach_connections set actor_id=auth.uid(),authority_stamp=stamp,workspace_version=(w->>'version')::bigint,
    lease_id=lease,lease_until=clock_timestamp()+interval '45 seconds',next_poll_at=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp()
    where id=c.id;
  return query select c.id,lease;
end; $$;
revoke all on function public.prepare_outreach_linkedin_review(uuid) from public,anon,authenticated,service_role;
grant execute on function public.prepare_outreach_linkedin_review(uuid) to authenticated;

create function public.read_outreach_linkedin_review(p_id uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_connections%rowtype; stamp text; w jsonb;
begin
  select * into c from public.outreach_connections where id=p_id;
  if not found or c.channel<>'linkedin' or c.state<>'uncertain' then return null; end if;
  stamp:=outreach_private.person_connection_authority(c.person_id,c.actor_id);
  w:=outreach_private.connection_workspace(c.client_id,'linkedin');
  if c.authority_stamp<>stamp or c.workspace_version<>(w->>'version')::bigint
    or p_lease is null or c.lease_id is distinct from p_lease or c.lease_until<=clock_timestamp() then return null; end if;
  return w||jsonb_build_object('channel','linkedin','email',c.expected_email,'remoteSession',null,'remoteAccount',c.remote_account,'expectedProfileUrl',c.expected_profile_url);
end; $$;
revoke all on function public.read_outreach_linkedin_review(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_outreach_linkedin_review(uuid,uuid) to service_role;

-- restore: the attempt returns to normal status checks with its sender; missing: expires once its
-- sign-in window has passed (as email does); unavailable: stays uncertain so it can be checked again.
create function public.finish_outreach_linkedin_review(p_id uuid,p_lease uuid,p_outcome text,p_remote_account text default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_connections%rowtype; stamp text; w jsonb; next_state text; sender text;
begin
  if p_outcome is null or p_outcome not in ('restore','missing','unavailable') then raise invalid_parameter_value; end if;
  select * into c from public.outreach_connections where id=p_id;
  if not found or c.channel<>'linkedin' then return false; end if;
  stamp:=outreach_private.person_connection_authority(c.person_id,c.actor_id);
  w:=outreach_private.connection_workspace(c.client_id,'linkedin');
  select * into c from public.outreach_connections where id=p_id for update;
  if c.state<>'uncertain' or c.authority_stamp<>stamp or c.workspace_version<>(w->>'version')::bigint
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
  next_state:=case when p_outcome='missing' and c.expires_at<=clock_timestamp() then 'expired' else 'uncertain' end;
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

-- 2. Release HeyReach senders created by attempts that failed or expired.
create function public.mark_outreach_remote_created(p_id uuid,p_remote_account text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  update public.outreach_connections set remote_created=true where id=p_id and channel='linkedin' and remote_account=p_remote_account;
  return found;
end; $$;
revoke all on function public.mark_outreach_remote_created(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.mark_outreach_remote_created(uuid,text) to service_role;

-- Callable by anyone who may connect this person; returns only senders Covora created for that
-- person's failed or expired attempts that no live attempt or connection uses.
create function public.list_outreach_remote_releases(p_person uuid) returns table(connection_id uuid,remote_account text)
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  perform outreach_private.person_connection_authority(p_person,auth.uid());
  return query select c.id,c.remote_account from public.outreach_connections c
    where c.person_id=p_person and c.channel='linkedin' and c.state in ('failed','expired') and c.remote_created
      and c.remote_released_at is null and c.remote_account is not null
      and not exists(select 1 from public.outreach_connections o where o.channel='linkedin' and o.remote_account=c.remote_account and o.id<>c.id
        and o.state in ('starting','pending','connected','uncertain','disconnecting','disconnect_uncertain'))
    order by c.created_at desc limit 3;
end; $$;
revoke all on function public.list_outreach_remote_releases(uuid) from public,anon,authenticated,service_role;
grant execute on function public.list_outreach_remote_releases(uuid) to authenticated;

create function public.mark_outreach_remote_released(p_id uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  update public.outreach_connections set remote_released_at=clock_timestamp()
    where id=p_id and channel='linkedin' and remote_created and remote_released_at is null and state in ('failed','expired');
  return found;
end; $$;
revoke all on function public.mark_outreach_remote_released(uuid) from public,anon,authenticated,service_role;
grant execute on function public.mark_outreach_remote_released(uuid) to service_role;

-- 3. Choosing the other email provider while a sign-in is open. Only the person who opened it can
-- close it, never mid-request, and no sooner than a new attempt could start anyway. The reserved
-- mailbox is checked first: a completed sign-in becomes connected, a missing one ends so the other
-- provider can start, and one that cannot be checked stays open exactly as it was.
create function public.prepare_outreach_email_switch(p_person uuid)
returns table(connection_id uuid,claim_token uuid)
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare person public.outreach_people%rowtype; c public.outreach_connections%rowtype; stamp text; w jsonb; lease uuid;
begin
  select * into person from public.outreach_people where id=p_person;
  if not found then raise insufficient_privilege; end if;
  stamp:=outreach_private.person_connection_authority(p_person,auth.uid());
  w:=outreach_private.connection_workspace(person.client_id,'email');
  select * into c from public.outreach_connections where person_id=p_person and channel='email' order by created_at desc,id desc limit 1 for update;
  if c.id is null or c.state<>'pending' or c.lease_id is not null or c.actor_id<>auth.uid() then
    return query select c.id,null::uuid; return;
  end if;
  if c.created_at>clock_timestamp()-interval '30 seconds' then
    raise exception using errcode='22023',message='Connection retry too soon'; end if;
  lease:=gen_random_uuid();
  update public.outreach_connections set state='uncertain',authority_stamp=stamp,workspace_version=(w->>'version')::bigint,
    lease_id=lease,lease_until=clock_timestamp()+interval '45 seconds',updated_at=clock_timestamp() where id=c.id;
  return query select c.id,lease;
end; $$;
revoke all on function public.prepare_outreach_email_switch(uuid) from public,anon,authenticated,service_role;
grant execute on function public.prepare_outreach_email_switch(uuid) to authenticated;

create function public.finish_outreach_email_switch(p_id uuid,p_lease uuid,p_outcome text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_connections%rowtype; stamp text; w jsonb;
begin
  if p_outcome is null or p_outcome not in ('connected','missing','unavailable') then raise invalid_parameter_value; end if;
  select * into c from public.outreach_connections where id=p_id;
  if not found or c.channel<>'email' then return false; end if;
  stamp:=outreach_private.person_connection_authority(c.person_id,c.actor_id);
  w:=outreach_private.connection_workspace(c.client_id,'email');
  select * into c from public.outreach_connections where id=p_id for update;
  if c.state<>'uncertain' or c.authority_stamp<>stamp or c.workspace_version<>(w->>'version')::bigint
    or p_lease is null or c.lease_id is distinct from p_lease or c.lease_until<=clock_timestamp() then return false; end if;
  if p_outcome='unavailable' then
    update public.outreach_connections set state='pending',lease_id=null,lease_until=null,updated_at=clock_timestamp() where id=c.id;
    return true;
  end if;
  if p_outcome='missing' then
    update public.outreach_connections set expires_at=least(expires_at,clock_timestamp()) where id=c.id;
  end if;
  return public.finish_outreach_email_review(p_id,p_lease,p_outcome);
exception when insufficient_privilege then return false;
end; $$;
revoke all on function public.finish_outreach_email_switch(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_outreach_email_switch(uuid,uuid,text) to service_role;
notify pgrst,'reload schema';
