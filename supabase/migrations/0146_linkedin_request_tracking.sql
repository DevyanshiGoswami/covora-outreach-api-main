begin;

-- Webhooks are wake-up signals only. Provider reads establish every status.
create table public.outreach_linkedin_hooks (
 workspace_id uuid primary key references public.outreach_reply_workspaces(id) on delete cascade,
 secret_hash text not null check(secret_hash ~ '^[a-f0-9]{64}$'),
 enabled boolean not null default false,
 last_received_at timestamptz,
 last_payload_hash text,
 received_count bigint not null default 0
);
create table public.outreach_linkedin_scans (
 campaign_id uuid primary key references public.outreach_campaigns(id) on delete cascade,
 workspace_id uuid not null references public.outreach_reply_workspaces(id) on delete cascade,
 page_offset integer not null default 0 check(page_offset>=0),
 requested_at timestamptz not null default now(),
 started_at timestamptz,
 due_at timestamptz not null default now(),
 last_served_at timestamptz,
 completed_at timestamptz,
 failures integer not null default 0
);
create table public.outreach_linkedin_requests (
 id uuid primary key default gen_random_uuid(),
 client_id uuid not null references public.clients(id) on delete cascade,
 campaign_id uuid not null references public.outreach_campaigns(id) on delete cascade,
 sender_id uuid not null references public.outreach_reply_senders(id) on delete cascade,
 recipient text not null,
 recipient_name text not null,
 status text not null check(status in ('sent','connected','replied')),
 first_seen_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 checked_at timestamptz not null default now(),
 unique(campaign_id,sender_id,recipient)
);
create index outreach_linkedin_requests_history on public.outreach_linkedin_requests(client_id,updated_at desc);
alter table public.outreach_linkedin_hooks enable row level security;
alter table public.outreach_linkedin_scans enable row level security;
alter table public.outreach_linkedin_requests enable row level security;
revoke all on public.outreach_linkedin_hooks,public.outreach_linkedin_scans,public.outreach_linkedin_requests from public,anon,authenticated;
grant select,insert,update,delete on public.outreach_linkedin_hooks,public.outreach_linkedin_scans,public.outreach_linkedin_requests to service_role;

create function outreach_private.linkedin_tracking_enabled(p_workspace uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select exists(select 1 from public.outreach_reply_workspaces w
 join public.outreach_linkedin_hooks h on h.workspace_id=w.id and h.enabled
 join public.client_features f on f.client_id=w.client_id and f.feature='outreach_app' and f.enabled
 where w.id=p_workspace and w.channel='linkedin' and w.sync_enabled and coalesce(f.config->>'presentation_mode','')<>'preview');
$$;
revoke all on function outreach_private.linkedin_tracking_enabled(uuid) from public,anon,authenticated;

create function public.receive_outreach_linkedin_hook(p_workspace uuid,p_secret_hash text,p_payload_hash text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare h public.outreach_linkedin_hooks%rowtype;
begin
 select * into h from public.outreach_linkedin_hooks where workspace_id=p_workspace and secret_hash=p_secret_hash and enabled for update;
 if not found or not outreach_private.linkedin_tracking_enabled(p_workspace) then return false; end if;
 update public.outreach_linkedin_hooks set last_received_at=now(),last_payload_hash=p_payload_hash,received_count=received_count+1 where workspace_id=p_workspace;
 -- Bursts and duplicate deliveries coalesce. The reconciliation still runs if a
 -- second identical notification arrives within this minute.
 if h.last_received_at>now()-interval '1 minute' and h.last_payload_hash=p_payload_hash then return true; end if;
 insert into public.outreach_linkedin_scans(campaign_id,workspace_id)
 select c.id,p_workspace from public.outreach_campaigns c join public.outreach_reply_workspaces w on w.client_id=c.client_id
 where w.id=p_workspace and c.channel='linkedin' and c.messages_purged_at is null
 on conflict(campaign_id) do update set requested_at=now(),due_at=least(outreach_linkedin_scans.due_at,now());
 -- Move this workspace's conversation reads forward without changing sender versions.
 update public.outreach_reply_senders set sync_started_at=null where workspace_id=p_workspace and channel='linkedin';
 return true;
end; $$;

create function public.next_outreach_linkedin_scan()
returns table(campaign_id uuid,client_id uuid,remote_campaign_id text,workspace_id uuid,workspace_version bigint,
 remote_workspace_id text,credential_ref text,page_offset integer,started_at timestamptz,failures integer,
 sender_ids uuid[],sender_versions bigint[],remote_sender_ids text[])
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 insert into public.outreach_linkedin_scans(campaign_id,workspace_id)
 select c.id,w.id from public.outreach_campaigns c join public.outreach_reply_workspaces w on w.client_id=c.client_id and w.channel='linkedin'
 where c.channel='linkedin' and c.messages_purged_at is null and outreach_private.linkedin_tracking_enabled(w.id)
 on conflict on constraint outreach_linkedin_scans_pkey do nothing;
 return query
 with candidate as materialized (
  select q.campaign_id from public.outreach_linkedin_scans q join public.outreach_campaigns c on c.id=q.campaign_id
  join public.outreach_reply_workspaces w on w.id=q.workspace_id and w.client_id=c.client_id
  where q.due_at<=now() and c.messages_purged_at is null and outreach_private.linkedin_tracking_enabled(w.id)
  order by q.last_served_at nulls first,q.campaign_id limit 1 for update of q skip locked
 ), claimed as (
  update public.outreach_linkedin_scans q set last_served_at=now(),due_at=now()+interval '2 minutes',started_at=coalesce(q.started_at,now())
  from candidate x where q.campaign_id=x.campaign_id returning q.*
 )
 select q.campaign_id,c.client_id,c.provider_campaign_id,w.id,w.version,w.remote_workspace_id,w.credential_ref,q.page_offset,q.started_at,q.failures,
 coalesce(a.ids,'{}'::uuid[]),coalesce(a.versions,'{}'::bigint[]),coalesce(a.remotes,'{}'::text[])
 from claimed q join public.outreach_campaigns c on c.id=q.campaign_id join public.outreach_reply_workspaces w on w.id=q.workspace_id
 cross join lateral (select array_agg(s.id order by s.id) ids,array_agg(s.version order by s.id) versions,array_agg(s.remote_sender_id order by s.id) remotes
 from public.outreach_reply_senders s where s.workspace_id=w.id and s.client_id=c.client_id and s.channel='linkedin') a;
end; $$;

create function public.save_outreach_linkedin_scan(p_campaign uuid,p_workspace uuid,p_workspace_version bigint,
 p_sender_ids uuid[],p_sender_versions bigint[],p_offset integer,p_started timestamptz,p_next_offset integer default null,p_rows jsonb default '[]'::jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_campaigns%rowtype; w public.outreach_reply_workspaces%rowtype; q public.outreach_linkedin_scans%rowtype;
 r jsonb; s public.outreach_reply_senders%rowtype; destination text; observed text;
begin
 select * into q from public.outreach_linkedin_scans where campaign_id=p_campaign for update;
 if not found or q.workspace_id<>p_workspace or q.page_offset<>p_offset or q.started_at is distinct from p_started then return false; end if;
 select * into c from public.outreach_campaigns where id=p_campaign and channel='linkedin' and messages_purged_at is null for share;
 if not found then return false; end if;
 select * into w from public.outreach_reply_workspaces where id=p_workspace and client_id=c.client_id for share;
 if not found or w.version<>p_workspace_version or not outreach_private.linkedin_tracking_enabled(w.id) then return false; end if;
 if cardinality(p_sender_ids) is null or cardinality(p_sender_ids) not between 1 and 100 or cardinality(p_sender_ids)<>cardinality(p_sender_versions) then return false; end if;
 perform 1 from public.outreach_reply_senders where id=any(p_sender_ids) order by id for share;
 if (select count(*) from unnest(p_sender_ids,p_sender_versions) x(id,version) join public.outreach_reply_senders bound on bound.id=x.id and bound.version=x.version and bound.workspace_id=w.id and bound.client_id=c.client_id)<>cardinality(p_sender_ids) then return false; end if;
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>100 or (p_next_offset is not null and p_next_offset<=p_offset) then raise exception 'Invalid observation'; end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  select * into s from public.outreach_reply_senders where id=(r->>'senderId')::uuid and id=any(p_sender_ids) and workspace_id=w.id and client_id=c.client_id;
  if not found then raise exception 'Invalid observation'; end if;
  destination:=r->>'recipient'; observed:=r->>'status';
  if destination is null or destination !~ '^https://www\.linkedin\.com/in/[a-z0-9_-]{1,200}$' or observed not in ('sent','connected','replied') or length(r->>'name')>500 then raise exception 'Invalid observation'; end if;
  insert into public.outreach_linkedin_requests(client_id,campaign_id,sender_id,recipient,recipient_name,status)
  values(c.client_id,c.id,s.id,destination,r->>'name',observed)
  on conflict(campaign_id,sender_id,recipient) do update set recipient_name=excluded.recipient_name,checked_at=now(),
   status=case when array_position(array['sent','connected','replied'],excluded.status)>array_position(array['sent','connected','replied'],outreach_linkedin_requests.status) then excluded.status else outreach_linkedin_requests.status end,
   updated_at=case when array_position(array['sent','connected','replied'],excluded.status)>array_position(array['sent','connected','replied'],outreach_linkedin_requests.status) then now() else outreach_linkedin_requests.updated_at end;
  -- Update a native command only when the exact campaign, sender and recipient match.
  update public.outreach_compose_commands cmd set status=observed,checked_at=now(),updated_at=now()
   where cmd.client_id=c.client_id and cmd.sender_id=s.id and cmd.remote_campaign_id=c.provider_campaign_id and cmd.channel='linkedin'
   and rtrim(regexp_replace(lower(cmd.recipient),'^https://(www\.)?','https://www.'),'/')=destination
   and cmd.status not in ('failed','replied') and array_position(array['preparing','unknown','queued','sent','connected','replied'],observed)>array_position(array['preparing','unknown','queued','sent','connected','replied'],cmd.status);
  update public.outreach_compose_commands cmd set checked_at=now() where cmd.client_id=c.client_id and cmd.sender_id=s.id and cmd.remote_campaign_id=c.provider_campaign_id and cmd.channel='linkedin'
   and rtrim(regexp_replace(lower(cmd.recipient),'^https://(www\.)?','https://www.'),'/')=destination;
 end loop;
 update public.outreach_linkedin_scans set page_offset=coalesce(p_next_offset,0),failures=0,
  started_at=case when p_next_offset is null then null else started_at end,
  completed_at=case when p_next_offset is null then now() else completed_at end,
  due_at=case when p_next_offset is not null or requested_at>p_started then now() else now()+interval '15 minutes' end
 where campaign_id=p_campaign;
 return true;
end; $$;

create function public.get_outreach_linkedin_tracking(p_client uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 perform outreach_private.compose_access(p_client,auth.uid(),false);
 return coalesce((select jsonb_agg(x.entry order by x.updated_at desc) from (
 select r.updated_at,jsonb_build_object('id',r.id,'clientId',r.client_id,'leadId',r.id,'senderId',r.sender_id,'channel','linkedin',
 'recipient',r.recipient,'recipientName',r.recipient_name,'senderName',s.sender_label,'senderAddress',s.sender_address,
 'subject','','body','','status',r.status,'createdAt',r.first_seen_at,'updatedAt',r.updated_at,'checkedAt',r.checked_at,'source','synced','noteAvailable',false) entry
 from public.outreach_linkedin_requests r join public.outreach_reply_senders s on s.id=r.sender_id and s.client_id=r.client_id
 where r.client_id=p_client and not exists(select 1 from public.outreach_compose_commands c where c.client_id=r.client_id and c.sender_id=r.sender_id and c.channel='linkedin'
 and c.remote_campaign_id=(select provider_campaign_id from public.outreach_campaigns where id=r.campaign_id)
 and rtrim(regexp_replace(lower(c.recipient),'^https://(www\.)?','https://www.'),'/')=r.recipient and c.status<>'failed')
 order by r.updated_at desc limit 100) x),'[]'::jsonb);
end; $$;
revoke all on function public.receive_outreach_linkedin_hook(uuid,text,text),public.next_outreach_linkedin_scan(),public.save_outreach_linkedin_scan(uuid,uuid,bigint,uuid[],bigint[],integer,timestamptz,integer,jsonb) from public,anon,authenticated;
grant execute on function public.receive_outreach_linkedin_hook(uuid,text,text),public.next_outreach_linkedin_scan(),public.save_outreach_linkedin_scan(uuid,uuid,bigint,uuid[],bigint[],integer,timestamptz,integer,jsonb) to service_role;
revoke all on function public.get_outreach_linkedin_tracking(uuid) from public,anon;
grant execute on function public.get_outreach_linkedin_tracking(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
