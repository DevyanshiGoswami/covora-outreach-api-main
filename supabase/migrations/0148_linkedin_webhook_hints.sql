begin;
-- The provider's public API does not retain custom headers on webhook writes.
-- An explicitly opted-in unsigned notification may only accelerate authoritative
-- reads, at most once per minute. Payload fields can never update contact state.
alter table public.outreach_linkedin_hooks add column unsigned_hints_enabled boolean not null default false;
create function public.receive_outreach_linkedin_hint(p_workspace uuid,p_payload_hash text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare h public.outreach_linkedin_hooks%rowtype;
begin
 select * into h from public.outreach_linkedin_hooks where workspace_id=p_workspace and enabled and unsigned_hints_enabled for update;
 if not found or not outreach_private.linkedin_tracking_enabled(p_workspace) then return false; end if;
 if h.last_received_at>now()-interval '1 minute' then return true; end if;
 -- Reuse the same queue operation after a server-only lookup. No credential,
 -- campaign, sender or recipient comes from the untrusted notification payload.
 return public.receive_outreach_linkedin_hook(p_workspace,h.secret_hash,p_payload_hash);
end; $$;
revoke all on function public.receive_outreach_linkedin_hint(uuid,text) from public,anon,authenticated;
grant execute on function public.receive_outreach_linkedin_hint(uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
