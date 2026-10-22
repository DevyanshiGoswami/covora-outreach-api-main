-- A successful LinkedIn connection records the verified profile on its sender.
-- Its primary email may differ from the email used to sign in. Give only the
-- leased backend disconnect operation that saved identity, scoped to the exact
-- client, sender and workspace binding. All authorization/lease fences remain.
create or replace function public.read_outreach_disconnect(p_id uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_connections%rowtype; stamp text; w jsonb; profile text;
begin
  select * into c from public.outreach_connections where id=p_id;
  if not found or c.state not in ('disconnecting','disconnect_uncertain') then return null; end if;
  stamp:=outreach_private.disconnect_authority(c.person_id,c.actor_id);
  w:=outreach_private.connection_workspace(c.client_id,c.channel);
  if c.authority_stamp<>stamp or c.workspace_version<>(w->>'version')::bigint or p_lease is null
    or c.lease_id is distinct from p_lease or c.lease_until<=clock_timestamp() then return null; end if;
  if c.channel='linkedin' then
    select sender_address into profile from public.outreach_reply_senders
      where client_id=c.client_id and channel='linkedin' and remote_sender_id=c.remote_account
        and workspace_id=(w->>'binding')::uuid;
  end if;
  return w||jsonb_build_object('channel',c.channel,'email',c.expected_email,'remoteSession',null,
    'remoteAccount',c.remote_account,'verifiedProfileUrl',profile);
end; $$;
revoke all on function public.read_outreach_disconnect(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_outreach_disconnect(uuid,uuid) to service_role;
