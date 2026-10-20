-- Read-only reconciliation of existing mailbox attempts. Never replay OAuth.
create function public.prepare_outreach_email_review(p_person uuid)
returns table(connection_id uuid,claim_token uuid)
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare person public.outreach_people%rowtype; c public.outreach_connections%rowtype; stamp text; w jsonb; lease uuid;
begin
  select * into person from public.outreach_people where id=p_person;
  if not found then raise insufficient_privilege; end if;
  stamp:=outreach_private.person_connection_authority(p_person,auth.uid());
  w:=outreach_private.connection_workspace(person.client_id,'email');
  select * into c from public.outreach_connections where person_id=p_person and channel='email' order by created_at desc,id desc limit 1 for update;
  if c.id is null then raise invalid_parameter_value; end if;
  -- Do not race an active provider request or a sign-in that is still pending.
  if (c.lease_id is not null and c.lease_until>clock_timestamp())
    or (c.state in ('starting','pending') and c.lease_id is null and c.expires_at>clock_timestamp())
    or c.next_poll_at>clock_timestamp() then
    return query select c.id,null::uuid; return;
  end if;
  -- Current authority and binding are freshly captured for this read-only check.
  -- Linking an external sender cannot let its previous manager review a teammate.
  lease:=gen_random_uuid();
  update public.outreach_connections set state='uncertain',actor_id=auth.uid(),authority_stamp=stamp,
    workspace_version=(w->>'version')::bigint,lease_id=lease,lease_until=clock_timestamp()+interval '45 seconds',
    auth_url=null,next_poll_at=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp() where id=c.id;
  return query select c.id,lease;
end; $$;
revoke all on function public.prepare_outreach_email_review(uuid) from public,anon,authenticated,service_role;
grant execute on function public.prepare_outreach_email_review(uuid) to authenticated;

create function public.read_outreach_email_review(p_id uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_connections%rowtype; stamp text; w jsonb;
begin
  select * into c from public.outreach_connections where id=p_id;
  if not found or c.channel<>'email' or c.state<>'uncertain' then return null; end if;
  stamp:=outreach_private.person_connection_authority(c.person_id,c.actor_id);
  w:=outreach_private.connection_workspace(c.client_id,'email');
  if c.authority_stamp<>stamp or c.workspace_version<>(w->>'version')::bigint
    or p_lease is null or c.lease_id is distinct from p_lease or c.lease_until<=clock_timestamp() then return null; end if;
  -- OAuth expiry does not prevent reading the independently reserved mailbox.
  return w||jsonb_build_object('channel','email','email',c.expected_email,'remoteSession',null,'remoteAccount',null);
end; $$;
revoke all on function public.read_outreach_email_review(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_outreach_email_review(uuid,uuid) to service_role;

create function public.finish_outreach_email_review(p_id uuid,p_lease uuid,p_outcome text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_connections%rowtype; stamp text; w jsonb; next_state text; affected integer;
begin
  if p_outcome is null or p_outcome not in ('connected','missing','unavailable') then raise invalid_parameter_value; end if;
  select * into c from public.outreach_connections where id=p_id;
  if not found or c.channel<>'email' then return false; end if;
  stamp:=outreach_private.person_connection_authority(c.person_id,c.actor_id);
  w:=outreach_private.connection_workspace(c.client_id,'email');
  select * into c from public.outreach_connections where id=p_id for update;
  if c.state<>'uncertain' or c.authority_stamp<>stamp or c.workspace_version<>(w->>'version')::bigint
    or p_lease is null or c.lease_id is distinct from p_lease or c.lease_until<=clock_timestamp() then return false; end if;
  next_state:=case when p_outcome='connected' then 'connected'
    when p_outcome='missing' and c.expires_at<=clock_timestamp() then 'expired' else 'uncertain' end;
  if next_state='connected' then
    update public.outreach_accounts set state='connected',last_checked_at=clock_timestamp(),last_connected_at=clock_timestamp(),
      check_error=false,updated_at=clock_timestamp() where client_id=c.client_id and email=c.expected_email;
    get diagnostics affected=row_count;
    if affected<>1 then raise invalid_parameter_value; end if;
  end if;
  update public.outreach_connections set state=next_state,remote_account=case when next_state='connected' then expected_email else remote_account end,
    auth_url=null,lease_id=null,lease_until=null,next_poll_at=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp() where id=c.id;
  insert into public.outreach_onboarding_audit(client_id,actor_id,subject_id,event) values(c.client_id,c.actor_id,c.id,'connection_finished');
  return true;
exception when insufficient_privilege then return false;
end; $$;
revoke all on function public.finish_outreach_email_review(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_outreach_email_review(uuid,uuid,text) to service_role;
notify pgrst,'reload schema';
