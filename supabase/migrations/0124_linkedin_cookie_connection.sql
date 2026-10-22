-- Keep browser session secrets out of SQL. Persist only the expected public profile.
alter table public.outreach_connections add column expected_profile_url text
  check (expected_profile_url is null or (channel='linkedin' and length(expected_profile_url)<=280
    and expected_profile_url ~ '^https://www[.]linkedin[.]com/in/[a-z0-9_%.-]+$'));

create function public.prepare_outreach_linkedin_cookies(p_person uuid,p_email text,p_profile text)
returns table(connection_id uuid,claim_token uuid)
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare claim record; saved_profile text;
begin
  if p_profile is null or length(p_profile)>280 or p_profile !~ '^https://www[.]linkedin[.]com/in/[a-z0-9_%.-]+$' then raise invalid_parameter_value; end if;
  -- The existing function retains self-auth, tenant, reservation and lease guards.
  select * into claim from public.prepare_outreach_connection(p_person,'linkedin','start',p_email);
  if claim.claim_token is not null then
    update public.outreach_connections set expected_profile_url=p_profile
      where id=claim.connection_id and lease_id=claim.claim_token and state='starting';
  else
    select expected_profile_url into saved_profile from public.outreach_connections where id=claim.connection_id;
    if saved_profile is distinct from p_profile then raise invalid_parameter_value; end if;
  end if;
  return query select claim.connection_id,claim.claim_token;
end; $$;
revoke all on function public.prepare_outreach_linkedin_cookies(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.prepare_outreach_linkedin_cookies(uuid,text,text) to authenticated;

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
  return w||jsonb_build_object('channel',c.channel,'email',c.expected_email,'remoteSession',c.remote_session,'remoteAccount',c.remote_account,'expectedProfileUrl',c.expected_profile_url);
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
