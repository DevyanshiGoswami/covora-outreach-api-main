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
  if c.id is null then raise invalid_parameter_value; end if;
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
notify pgrst,'reload schema';
