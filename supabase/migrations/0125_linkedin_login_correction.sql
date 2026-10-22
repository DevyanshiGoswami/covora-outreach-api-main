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
    if c.created_at>clock_timestamp()-interval '30 seconds' then
      raise exception using errcode='22023',message='Connection retry too soon'; end if;
    address:=case when p_channel='email' then person.email else outreach_private.account_email(p_email) end;
    if address is null or length(address)>254 or address !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise invalid_parameter_value; end if;
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
          and (state<>'failed' or remote_account is not null or remote_session is not null or lease_id is not null)) then
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

notify pgrst,'reload schema';
