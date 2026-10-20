begin;
-- Shared network workspaces retain exclusive sender/campaign assignments and tenant gates.
lock table public.outreach_reply_workspaces in share row exclusive mode;
drop index public.outreach_linkedin_workspace_identity;
drop index public.outreach_linkedin_workspace_credential;
create index outreach_linkedin_workspace_credential on public.outreach_reply_workspaces(credential_ref) where channel='linkedin';
create table outreach_private.network_credential_guards(credential_ref text primary key);
alter table outreach_private.network_credential_guards enable row level security;
revoke all on outreach_private.network_credential_guards from public,anon,authenticated,service_role;
create function outreach_private.guard_network_workspace_credential() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 insert into outreach_private.network_credential_guards values(new.credential_ref)
 on conflict(credential_ref) do update set credential_ref=excluded.credential_ref;
 if exists(select 1 from public.outreach_reply_workspaces w where w.channel='linkedin'
   and w.credential_ref=new.credential_ref and w.remote_workspace_id<>new.remote_workspace_id and w.id<>new.id) then
   raise exception using errcode='22023',message='Network credential workspace mismatch';
 end if;
 return new;
end; $$;
revoke all on function outreach_private.guard_network_workspace_credential() from public,anon,authenticated,service_role;
create trigger outreach_network_workspace_credential before insert or update of credential_ref,remote_workspace_id
 on public.outreach_reply_workspaces for each row when(new.channel='linkedin') execute function outreach_private.guard_network_workspace_credential();

create or replace function outreach_private.initialize_sync_state() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 insert into public.outreach_sync_state(campaign_id,client_id) values(new.id,new.client_id);
 return new;
end; $$;
insert into public.outreach_sync_state(campaign_id,client_id)
 select id,client_id from public.outreach_campaigns where channel='linkedin' on conflict(campaign_id) do nothing;

create function outreach_private.network_totals(value jsonb) returns jsonb
language sql immutable set search_path=pg_catalog,public,pg_temp as $$
 select jsonb_object_agg(k,case when jsonb_typeof(value->k)='number' then case when (value->>k)::numeric between 0 and 9007199254740991
   and trunc((value->>k)::numeric)=(value->>k)::numeric then value->k else 'null'::jsonb end else 'null'::jsonb end)
 from unnest(array['leads','invitations_sent','invitations_accepted','messages_sent','replies']) k;
$$;
revoke all on function outreach_private.network_totals(jsonb) from public,anon,authenticated,service_role;
create function outreach_private.read_network_campaigns()
returns table(id uuid,client_id uuid,name text,status text,totals jsonb,synced_at timestamptz,schedule jsonb)
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select c.id,c.client_id,c.name,c.status,outreach_private.network_totals(c.totals),c.synced_at,outreach_private.schedule(c.schedule)
 from public.outreach_campaigns c where c.channel='linkedin' and outreach_private.can_read(c.client_id);
$$;
revoke all on function outreach_private.read_network_campaigns() from public,anon,authenticated,service_role;
grant execute on function outreach_private.read_network_campaigns() to authenticated;
create view public.client_outreach_network_campaigns with(security_invoker=true,security_barrier=true)
 as select * from outreach_private.read_network_campaigns();
revoke all on public.client_outreach_network_campaigns from public,anon,authenticated,service_role;
grant select on public.client_outreach_network_campaigns to authenticated;
comment on view public.client_outreach_network_campaigns is 'Campaign-scoped network totals since campaign creation. Null is unavailable. Replies are provider-reported message replies, not booked meetings. No daily cohort inference.';

create function public.save_outreach_network_campaign(p_campaign_id uuid,p_workspace_id uuid,p_workspace_version bigint,p_sender_ids uuid[],p_sender_versions bigint[],p_name text,p_status text,p_totals jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_campaigns%rowtype; w public.outreach_reply_workspaces%rowtype; now_at timestamptz:=clock_timestamp();
begin
 select * into c from public.outreach_campaigns where id=p_campaign_id and channel='linkedin' for update;
 if not found then return false; end if;
 perform 1 from public.clients where id=c.client_id for no key update;
 select * into w from public.outreach_reply_workspaces where id=p_workspace_id and client_id=c.client_id and channel='linkedin' for share;
 if not found or p_workspace_version is null or not w.sync_enabled or w.version<>p_workspace_version or not exists(select 1 from public.client_features where client_id=c.client_id and feature='outreach_app' and enabled) then return false; end if;
 if cardinality(p_sender_ids) is null or cardinality(p_sender_ids) not between 1 and 100 or cardinality(p_sender_ids)<>cardinality(p_sender_versions)
   or (select count(distinct v) from unnest(p_sender_ids) v)<>cardinality(p_sender_ids) then return false; end if;
 perform 1 from public.outreach_reply_senders where id=any(p_sender_ids) order by id for share;
 if (select count(*) from unnest(p_sender_ids,p_sender_versions) x(id,version)
   join public.outreach_reply_senders s on s.id=x.id and s.version=x.version and s.workspace_id=w.id and s.client_id=c.client_id and s.channel='linkedin')<>cardinality(p_sender_ids) then return false; end if;
 if p_status is null or p_name is null or p_totals is null or p_status not in ('draft','active','paused','completed','stopped','unknown') or length(p_name) not between 1 and 500 or jsonb_typeof(p_totals)<>'object' then raise exception using errcode='22023',message='Invalid network observation'; end if;
 update public.outreach_campaigns set name=p_name,status=p_status,totals=outreach_private.network_totals(p_totals),synced_at=now_at where id=c.id;
 update public.outreach_sync_state set meta_synced_at=now_at,retry_after=null,attempt_count=0,last_error=null where campaign_id=c.id;
 return true;
end; $$;
revoke all on function public.save_outreach_network_campaign(uuid,uuid,bigint,uuid[],bigint[],text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.save_outreach_network_campaign(uuid,uuid,bigint,uuid[],bigint[],text,text,jsonb) to service_role;

-- Eligibility is applied before the bounded oldest-first selection. Disabled
-- tenants or workspace bindings cannot starve an eligible campaign behind them.
create function public.next_outreach_network_campaign()
returns table(id uuid,client_id uuid,provider_campaign_id text,workspace_id uuid,remote_workspace_id text,
 workspace_version bigint,credential_ref text,attempt_count integer,sender_ids uuid[],sender_versions bigint[],remote_sender_ids text[])
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 with candidate as materialized (
  select c.id,c.client_id,c.provider_campaign_id,w.id as workspace_id,w.remote_workspace_id,w.version,w.credential_ref,s.attempt_count
  from public.outreach_sync_state s
  join public.outreach_campaigns c on c.id=s.campaign_id and c.client_id=s.client_id and c.channel='linkedin'
  join public.outreach_reply_workspaces w on w.client_id=c.client_id and w.channel='linkedin' and w.sync_enabled
  join public.client_features f on f.client_id=c.client_id and f.feature='outreach_app' and f.enabled
  where (s.retry_after is null or s.retry_after<=now()) and (s.meta_synced_at is null or s.meta_synced_at<=now()-interval '5 minutes')
  order by s.last_served_at nulls first,c.id limit 1
 )
 select c.id,c.client_id,c.provider_campaign_id,c.workspace_id,c.remote_workspace_id,c.version,c.credential_ref,c.attempt_count,
  coalesce(a.ids,'{}'::uuid[]),coalesce(a.versions,'{}'::bigint[]),coalesce(a.remotes,'{}'::text[])
 from candidate c cross join lateral (
  select array_agg(x.id order by x.id) ids,array_agg(x.version order by x.id) versions,array_agg(x.remote_sender_id order by x.id) remotes
  from (select s.id,s.version,s.remote_sender_id from public.outreach_reply_senders s
   where s.workspace_id=c.workspace_id and s.client_id=c.client_id and s.channel='linkedin' order by s.id limit 101) x
 ) a;
$$;
revoke all on function public.next_outreach_network_campaign() from public,anon,authenticated,service_role;
grant execute on function public.next_outreach_network_campaign() to service_role;

notify pgrst,'reload schema';

commit;
