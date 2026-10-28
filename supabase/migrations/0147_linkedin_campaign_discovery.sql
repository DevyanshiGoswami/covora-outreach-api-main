begin;
alter table public.outreach_linkedin_hooks add column discovery_offset integer not null default 0,
 add column discovery_due_at timestamptz not null default now(),add column discovery_claim uuid;
create function public.claim_outreach_linkedin_discovery() returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare h public.outreach_linkedin_hooks%rowtype; w public.outreach_reply_workspaces%rowtype; token uuid:=gen_random_uuid();
begin
 select * into h from public.outreach_linkedin_hooks where discovery_due_at<=now() and outreach_private.linkedin_tracking_enabled(workspace_id)
 order by discovery_due_at,workspace_id limit 1 for update skip locked;
 if not found then return null; end if;
 select * into w from public.outreach_reply_workspaces where id=h.workspace_id;
 update public.outreach_linkedin_hooks set discovery_claim=token,discovery_due_at=now()+interval '2 minutes' where workspace_id=w.id;
 return jsonb_build_object('workspaceId',w.id,'workspaceVersion',w.version,'remoteWorkspaceId',w.remote_workspace_id,'credentialRef',w.credential_ref,'offset',h.discovery_offset,'claim',token,
 'senders',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'version',s.version,'remoteId',s.remote_sender_id)) from public.outreach_reply_senders s where s.workspace_id=w.id and s.client_id=w.client_id and s.channel='linkedin'),'[]'::jsonb));
end; $$;
create function public.save_outreach_linkedin_discovery(p_workspace uuid,p_version bigint,p_claim uuid,p_senders jsonb,p_campaigns jsonb,p_next_offset integer default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare w public.outreach_reply_workspaces%rowtype; r jsonb; sender_count integer;
begin
 perform 1 from public.outreach_linkedin_hooks where workspace_id=p_workspace and discovery_claim=p_claim for update;
 if not found then return false; end if;
 select * into w from public.outreach_reply_workspaces where id=p_workspace and version=p_version for share;
 if not found or not outreach_private.linkedin_tracking_enabled(w.id) then return false; end if;
 if jsonb_typeof(p_senders)<>'array' or jsonb_typeof(p_campaigns)<>'array' or jsonb_array_length(p_senders) not between 1 and 100 or jsonb_array_length(p_campaigns)>100 then return false; end if;
 perform 1 from public.outreach_reply_senders where workspace_id=w.id order by id for share;
 select count(*) into sender_count from jsonb_to_recordset(p_senders) x(id uuid,version bigint,"remoteId" text)
 join public.outreach_reply_senders s on s.id=x.id and s.version=x.version and s.remote_sender_id=x."remoteId" and s.workspace_id=w.id and s.client_id=w.client_id;
 if sender_count<>jsonb_array_length(p_senders) then return false; end if;
 for r in select value from jsonb_array_elements(p_campaigns) loop
  if r->>'workspace'<>w.remote_workspace_id or jsonb_typeof(r->'accounts')<>'array' or jsonb_array_length(r->'accounts')=0 or r->>'id' !~ '^[1-9][0-9]{0,15}$'
   or exists(select 1 from jsonb_array_elements_text(r->'accounts') x(id) where not exists(select 1 from public.outreach_reply_senders s where s.workspace_id=w.id and s.client_id=w.client_id and s.remote_sender_id=x.id))
  then raise exception 'Campaign scope mismatch'; end if;
  insert into public.outreach_campaigns(client_id,channel,provider_campaign_id,name,status)
  values(w.client_id,'linkedin',r->>'id',left(r->>'name',500),r->>'status')
  on conflict(provider_campaign_id) do nothing;
 end loop;
 update public.outreach_linkedin_hooks set discovery_offset=coalesce(p_next_offset,0),discovery_claim=null,
 discovery_due_at=case when p_next_offset is null then now()+interval '15 minutes' else now() end where workspace_id=w.id;
 return true;
end; $$;
revoke all on function public.claim_outreach_linkedin_discovery(),public.save_outreach_linkedin_discovery(uuid,bigint,uuid,jsonb,jsonb,integer) from public,anon,authenticated;
grant execute on function public.claim_outreach_linkedin_discovery(),public.save_outreach_linkedin_discovery(uuid,bigint,uuid,jsonb,jsonb,integer) to service_role;
notify pgrst,'reload schema';
commit;
