-- Imported rosters remain separate from provider campaigns and sending analytics.
create table public.outreach_lead_lists (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null check(length(name) between 1 and 500),
  source_kind text not null default 'import' check(source_kind = 'import'),
  source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
  imported_at timestamptz not null default now(),
  unique(id,client_id)
);
create table public.outreach_imported_leads (
  id uuid primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  list_id uuid not null,
  source_row_id text not null check(source_row_id ~ '^[a-f0-9]{64}$'),
  first_name text not null default '' check(length(first_name)<=500),
  last_name text not null default '' check(length(last_name)<=500),
  company text not null default '' check(length(company)<=500),
  job_title text check(job_title is null or length(job_title)<=500),
  location text check(location is null or length(location)<=500),
  email text check(email is null or (length(email)<=254 and email !~ '[[:cntrl:]]' and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')),
  email_verification text not null default 'unknown' check(email_verification in ('verified','unverified','unknown')),
  email_verification_evidence text check(email_verification_evidence is null or length(email_verification_evidence) between 1 and 1000),
  linkedin_url text check(linkedin_url is null or linkedin_url ~ '^https://www\.linkedin\.com/in/[a-zA-Z0-9_-]{1,200}$'),
  linkedin_verified boolean,
  linkedin_verification_evidence text check(linkedin_verification_evidence is null or length(linkedin_verification_evidence) between 1 and 1000),
  role_category text check(role_category in ('owners-executives','vp-director','manager-other')),
  status text not null default 'not_contacted' check(status = 'not_contacted'),
  imported_at timestamptz not null default now(),
  foreign key(list_id,client_id) references public.outreach_lead_lists(id,client_id) on delete cascade,
  unique(list_id,source_row_id),
  check(email_verification = 'unknown' or (email is not null and email_verification_evidence is not null)),
  check(linkedin_verified is not true or (linkedin_url is not null and linkedin_verification_evidence is not null))
);
create index outreach_imported_leads_directory_idx on public.outreach_imported_leads(client_id,lower(company),id);
create index outreach_imported_leads_list_idx on public.outreach_imported_leads(client_id,list_id,id);
create unique index outreach_imported_leads_email_idx on public.outreach_imported_leads(list_id,lower(email)) where email is not null;
alter table public.outreach_lead_lists enable row level security;
alter table public.outreach_imported_leads enable row level security;
create policy outreach_lead_lists_service on public.outreach_lead_lists for all to service_role using(true) with check(true);
create policy outreach_imported_leads_service on public.outreach_imported_leads for all to service_role using(true) with check(true);
revoke all on table public.outreach_lead_lists,public.outreach_imported_leads from public,anon,authenticated,service_role;
grant select,insert,update,delete on table public.outreach_lead_lists,public.outreach_imported_leads to service_role;

-- Presentation alone conveys no entitlement. Only the existing feature/membership
-- checks determine visibility, including agency access.
create function outreach_private.workspace_is_preview(p_client_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select coalesce((select config->>'presentation_mode' = 'preview' from public.client_features
    where client_id=p_client_id and feature='outreach_app'),false);
$$;
revoke all on function outreach_private.workspace_is_preview(uuid) from public,anon,authenticated,service_role;
drop view public.client_outreach_workspaces;
drop function outreach_private.read_workspaces();
create function outreach_private.read_workspaces()
returns table(client_id uuid,client_name text,role text,presentation_mode text)
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select c.id,c.name,outreach_private.workspace_role(c.id),
    case when outreach_private.workspace_is_preview(c.id) then 'preview' else 'live' end
  from public.clients c where outreach_private.can_read(c.id);
$$;
revoke all on function outreach_private.read_workspaces() from public,anon,authenticated,service_role;
grant execute on function outreach_private.read_workspaces() to authenticated;
create view public.client_outreach_workspaces with(security_invoker=true,security_barrier=true)
  as select * from outreach_private.read_workspaces();
revoke all on table public.client_outreach_workspaces from public,anon,authenticated,service_role;
grant select on table public.client_outreach_workspaces to authenticated;

-- One extended overload preserves all old named/default arguments.
drop function public.list_outreach_leads(uuid,text,text,text,uuid,text,text,text,text,integer);
create function public.list_outreach_leads(
  p_client_id uuid,
  p_q text default '',
  p_role text default 'all',
  p_company text default '',
  p_campaign uuid default null,
  p_email text default 'all',
  p_linkedin text default 'all',
  p_status text default 'all',
  p_sort text default 'company',
  p_page integer default 1,
  p_list uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare result jsonb;
begin
  if auth.uid() is null or p_client_id is null or not outreach_private.can_read(p_client_id) then
    raise exception 'Lead access denied' using errcode = '42501';
  end if;
  if p_q is null or length(p_q) > 200 or p_company is null or length(p_company) > 500
    or p_role is null or p_role not in ('all','owners-executives','vp-director','manager-other')
    or p_email is null or p_email not in ('all','available','verified')
    or p_linkedin is null or p_linkedin not in ('all','available','verified')
    or p_status is null or p_status not in ('all','not_contacted','contacted','replied','completed')
    or p_sort is null or p_sort not in ('company','name','role')
    or p_page is null or p_page < 1 or p_page > 1000000 then
    raise exception 'Invalid lead filters' using errcode = '22023';
  end if;

  -- This single snapshot scopes rows, counts and filter choices to the same
  -- authorized client. All user values are parameters, never dynamic SQL.
  with base as materialized (
    select l.id, l.client_id, l.campaign_id, outreach_private.lead_display_text(c.name) as campaign_name, null::uuid as list_id, null::text as list_name,
      outreach_private.lead_display_text(l.first_name) as first_name, outreach_private.lead_display_text(l.last_name) as last_name,
      outreach_private.lead_display_text(concat_ws(' ',l.first_name,l.last_name)) as full_name,
      outreach_private.lead_display_text(l.company) as company, nullif(outreach_private.lead_display_text(l.job_title),'') as job_title, nullif(outreach_private.lead_display_text(l.location),'') as location,
      case when length(l.email) <= 254 and l.email !~ '[[:cntrl:]]' and l.email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then l.email else null end as email,
      case when length(l.email) <= 254 and l.email !~ '[[:cntrl:]]' and l.email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then l.email_verification else 'unknown' end as email_verification,
      l.linkedin_url, l.linkedin_verified,
      l.role_category, case when l.status in ('not_contacted','in_sequence','contacted','replied','completed','bounced','unsubscribed','skipped','paused') then l.status else 'unknown' end as status,
      nullif(outreach_private.lead_display_text(l.interest),'') as interest, l.last_activity_at
    from public.outreach_leads l
    join public.outreach_campaigns c on c.id = l.campaign_id and c.client_id = l.client_id
    where l.client_id = p_client_id
    union all
    select l.id,l.client_id,null::uuid,null::text,l.list_id,outreach_private.lead_display_text(s.name),
      outreach_private.lead_display_text(l.first_name),outreach_private.lead_display_text(l.last_name),
      outreach_private.lead_display_text(concat_ws(' ',l.first_name,l.last_name)),
      outreach_private.lead_display_text(l.company),nullif(outreach_private.lead_display_text(l.job_title),''),nullif(outreach_private.lead_display_text(l.location),''),
      l.email,l.email_verification,l.linkedin_url,l.linkedin_verified,l.role_category,l.status,null::text,null::timestamptz
    from public.outreach_imported_leads l join public.outreach_lead_lists s on s.id=l.list_id and s.client_id=l.client_id
    where l.client_id=p_client_id
  ), filtered as materialized (
    select * from base b
    where (outreach_private.lead_display_text(p_q) = '' or strpos(lower(concat_ws(' ',b.first_name,b.last_name,b.company,b.job_title,b.location,b.email,b.linkedin_url,b.campaign_name,b.list_name)),lower(outreach_private.lead_display_text(p_q))) > 0)
      and (p_role = 'all' or coalesce(b.role_category,'manager-other') = p_role)
      and (outreach_private.lead_display_text(p_company) = '' or lower(b.company) = lower(outreach_private.lead_display_text(p_company)))
      and (p_campaign is null or b.campaign_id = p_campaign)
      and (p_list is null or b.list_id = p_list)
      and (p_email = 'all' or p_email = 'available' and b.email is not null or p_email = 'verified' and b.email is not null and b.email_verification = 'verified')
      and (p_linkedin = 'all' or p_linkedin = 'available' and b.linkedin_url is not null or p_linkedin = 'verified' and b.linkedin_url is not null and b.linkedin_verified is true)
      and (p_status = 'all' or p_status = b.status or p_status = 'contacted' and b.status = 'in_sequence')
  ), totals as (
    select count(*) as n, least(p_page::bigint,greatest(1,(count(*) + 35)/36))::integer as page from filtered
  ), ordered as (
    select b.*, row_number() over(order by
      case p_sort when 'company' then nullif(lower(b.company),'') when 'role' then nullif(lower(b.job_title),'') else nullif(lower(b.full_name),'') end nulls last,
      lower(b.full_name), lower(b.email), b.id) as row_no
    from filtered b
  ), page_rows as (
    select o.* from ordered o cross join totals t
    where o.row_no > (t.page::bigint-1)*36 and o.row_no <= t.page::bigint*36
  ), companies as materialized (
    select min(b.company) as name, lower(b.company) as key from base b where b.company <> '' group by lower(b.company)
  ), company_options as (
    select * from (select name,key from companies order by key limit 1000) first_options
    union select name,key from companies where key = lower(outreach_private.lead_display_text(p_company))
  ), campaigns as materialized (
    select distinct b.campaign_id as id,b.campaign_name as name from base b where b.campaign_id is not null
  ), campaign_options as (
    select * from (select id,name from campaigns order by lower(name),id limit 500) first_options
    union select id,name from campaigns where id = p_campaign
  ), lists as materialized (
    select s.id,outreach_private.lead_display_text(s.name) as name from public.outreach_lead_lists s where s.client_id=p_client_id
  ), list_options as (
    select * from (select id,name from lists order by lower(name),id limit 500) first_options
    union select id,name from lists where id=p_list
  )
  select jsonb_build_object(
    'clientId',p_client_id,
    'leads',coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.id,'clientId',r.client_id,'campaignId',r.campaign_id,'campaignName',r.campaign_name,'listId',r.list_id,'listName',r.list_name,
      'firstName',r.first_name,'lastName',r.last_name,'fullName',r.full_name,'company',r.company,
      'jobTitle',r.job_title,'location',r.location,'email',r.email,'emailVerification',r.email_verification,
      'linkedinUrl',r.linkedin_url,'linkedinVerified',r.linkedin_verified,'status',r.status,
      'interest',r.interest,'lastActivityAt',r.last_activity_at
    ) order by r.row_no) from page_rows r),'[]'::jsonb),
    'total',t.n,'page',t.page,'pageSize',36,
    'summary',jsonb_build_object(
      'total',(select count(*) from base),
      'verifiedEmail',(select count(*) from base where email is not null and email_verification = 'verified'),
      'withLinkedIn',(select count(*) from base where linkedin_url is not null),
      'companies',(select count(*) from companies)
    ),
    'companies',coalesce((select jsonb_agg(name order by key) from company_options),'[]'::jsonb),
    'campaigns',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by lower(name),id) from campaign_options),'[]'::jsonb),
    'lists',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by lower(name),id) from list_options),'[]'::jsonb),
    'filterOptionsTruncated',(select count(*) > 1000 from companies) or (select count(*) > 500 from campaigns) or (select count(*) > 500 from lists)
  ) into result from totals t;
  return result;
end;
$$;
revoke all on function public.list_outreach_leads(uuid,text,text,text,uuid,text,text,text,text,integer,uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_outreach_leads(uuid,text,text,text,uuid,text,text,text,text,integer,uuid) to authenticated;

-- Preview reply fences share the existing locked enqueue/claim/dispatch authority path.
create or replace function outreach_private.lock_reply_authority(p_client_id uuid,p_actor_id uuid) returns text
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare actor_role text; actor_version bigint;
begin
  perform outreach_private.lock_team_workspace(p_client_id);
  if outreach_private.workspace_is_preview(p_client_id) then raise exception using errcode='42501',message='Replies are disabled in preview'; end if;
  actor_role:=outreach_private.lock_team_role(p_client_id,p_actor_id);
  if actor_role is null or actor_role not in ('agency_owner','operator','client_admin','client_member') then
    raise exception using errcode='42501',message='Reply access denied';
  end if;
  if actor_role='agency_owner' then select version into actor_version from public.outreach_agency_memberships where user_id=p_actor_id;
  else select version into actor_version from public.outreach_memberships where client_id=p_client_id and user_id=p_actor_id; end if;
  return actor_role||':'||actor_version;
end; $$;
create or replace function outreach_private.conversation_summary(p_row public.outreach_conversations) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare permitted boolean; reason text; sender public.outreach_reply_senders%rowtype; workspace public.outreach_reply_workspaces%rowtype; latest public.outreach_conversation_messages%rowtype;
begin
  permitted:=not outreach_private.workspace_is_preview(p_row.client_id) and coalesce(outreach_private.workspace_role(p_row.client_id) in ('agency_owner','operator','client_admin','client_member'),false);
  select * into sender from public.outreach_reply_senders where id=p_row.sender_id;
  select * into workspace from public.outreach_reply_workspaces where id=sender.workspace_id;
  select * into latest from public.outreach_conversation_messages where id=p_row.latest_message_id;
  if outreach_private.workspace_is_preview(p_row.client_id) then reason:='Replies are disabled in preview.';
  elsif not permitted then reason:='Your workspace role has read-only access.';
  elsif p_row.suppressed then reason:='Replies are unavailable for this conversation.';
  elsif sender.id is null or not sender.enabled or not coalesce(workspace.enabled,false) then reason:='Replies are not enabled for this account.';
  elsif latest.id is null or (p_row.channel='email' and not exists(select 1 from public.outreach_conversation_messages where conversation_id=p_row.id and direction='received')) then reason:='A current conversation is required before replying.';
  elsif exists(select 1 from public.outreach_reply_commands where sender_id=sender.id and (status in ('sending','unknown') or (status in ('queued','preparing') and expires_at>clock_timestamp()))) then reason:='A reply is being checked or its outcome needs review.';
  elsif exists(select 1 from public.outreach_reply_commands where conversation_id=p_row.id and status='queued' and expires_at>clock_timestamp()) then reason:='A reply is waiting to send.';
  end if;
  return jsonb_build_object('id',p_row.id,'clientId',p_row.client_id,'channel',p_row.channel,'campaignId',p_row.campaign_id,
   'campaignName',coalesce((select name from public.outreach_campaigns where id=p_row.campaign_id),''),'subject',p_row.subject,
   'contactName',p_row.contact_name,'contactAddress',p_row.contact_address,'senderLabel',coalesce(sender.sender_label,p_row.sender_address),
   'owner',jsonb_build_object('kind',case when p_row.owner_user_id is null then 'covora' else 'user' end,'userId',p_row.owner_user_id,
     'name',case when p_row.owner_user_id is null then 'Covora' else coalesce((select nullif(full_name,'') from public.profiles where id=p_row.owner_user_id),'Workspace member') end),
   'ownedByMe',coalesce(p_row.owner_user_id=auth.uid(),false),'version',p_row.version,'latestMessageId',p_row.latest_message_id,
   'latestAt',p_row.latest_at,'preview',left(coalesce(latest.body_text,''),300),
   'unread',exists(select 1 from public.outreach_conversation_messages m where m.conversation_id=p_row.id and m.direction='received'
       and m.created_at>coalesce((select read_at from public.outreach_conversation_reads where conversation_id=p_row.id and user_id=auth.uid()),'-infinity'::timestamptz)),
   'interest',(select original.interest from public.outreach_conversation_messages m join public.outreach_messages original on original.id=m.source_message_id where m.conversation_id=p_row.id and m.direction='received' order by m.sent_at desc,m.remote_message_id desc limit 1),
   'status',p_row.status,'canReply',reason is null,'canTakeover',permitted,'replyUnavailableReason',reason);
end; $$;
