-- Review status is an authorization boundary, independent of sending status.
-- Existing rosters retain their visibility until a specifically reviewed import.
alter table public.outreach_imported_leads
  add column review_state text not null default 'client' check(review_state in ('client','escrow')),
  add column priority_rank integer check(priority_rank between 1 and 1000000),
  add column fit_reason text check(fit_reason is null or length(fit_reason) between 1 and 2000),
  add column review_reason text check(review_reason is null or length(review_reason) between 1 and 2000),
  add column reviewed_at timestamptz,
  add column review_evidence jsonb not null default '{}'::jsonb check(jsonb_typeof(review_evidence)='object'),
  add constraint outreach_imported_leads_review_consistent check(
    (review_state <> 'escrow' or (priority_rank is null and review_reason is not null and reviewed_at is not null))
    and (priority_rank is null or (review_state='client' and fit_reason is not null and reviewed_at is not null))
  );
create index outreach_imported_leads_review_idx on public.outreach_imported_leads(client_id,review_state,priority_rank,id);
create unique index outreach_imported_leads_priority_idx on public.outreach_imported_leads(client_id,priority_rank) where priority_rank is not null;

-- Only allowlisted display fields leave private evidence storage. Provider
-- receipts, raw records, internal IDs and arbitrary metadata never leave it.
create function outreach_private.lead_research_projection(p_rank integer,p_fit text,p_reviewed timestamptz,p_evidence jsonb)
returns jsonb language sql stable set search_path=pg_catalog,public,pg_temp as $$
  select jsonb_build_object(
    'priorityRank',p_rank,'fitReason',p_fit,'researchedAt',p_reviewed,
    'emailValidation',case when p_evidence->>'emailValidation' in ('valid','risky','unknown','invalid') then p_evidence->>'emailValidation' else null end,
    'contactPreference',case when p_evidence->>'contactPreference' in ('email_and_linkedin','linkedin_first') then p_evidence->>'contactPreference' else null end,
    'researchGaps',case when jsonb_typeof(p_evidence->'researchGaps')='string' then nullif(left(btrim(regexp_replace(p_evidence->>'researchGaps','[[:cntrl:]]+',' ','g')),4000),'') else null end,
    'sourceUrls',coalesce((select jsonb_agg(url order by ordinal) from (
      select item #>> '{}' as url,ordinal from jsonb_array_elements(case when jsonb_typeof(p_evidence->'sourceUrls')='array' then p_evidence->'sourceUrls' else '[]'::jsonb end) with ordinality as links(item,ordinal)
      where jsonb_typeof(item)='string' and length(item #>> '{}')<=1500
        and (item #>> '{}') ~ '^https://([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}(/[^[:space:]?#]*)?$'
      order by ordinal limit 20
    ) safe_urls),'[]'::jsonb)
  );
$$;
revoke all on function outreach_private.lead_research_projection(integer,text,timestamptz,jsonb) from public,anon,authenticated,service_role;

-- The client directory below never includes escrow, even for an agency user.
-- A separate operator projection makes the review boundary explicit.

create or replace function public.list_outreach_leads(
  p_client_id uuid,
  p_q text default '',
  p_role text default 'all',
  p_company text default '',
  p_campaign uuid default null,
  p_email text default 'all',
  p_linkedin text default 'all',
  p_status text default 'all',
  p_sort text default 'priority',
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
    or p_sort is null or p_sort not in ('priority','company','name','role')
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
      nullif(outreach_private.lead_display_text(l.interest),'') as interest, l.last_activity_at,
      null::integer as priority_rank, null::text as fit_reason, null::timestamptz as reviewed_at, '{}'::jsonb as review_evidence
    from public.outreach_leads l
    join public.outreach_campaigns c on c.id = l.campaign_id and c.client_id = l.client_id
    where l.client_id = p_client_id
    union all
    select l.id,l.client_id,null::uuid,null::text,l.list_id,outreach_private.lead_display_text(s.name),
      outreach_private.lead_display_text(l.first_name),outreach_private.lead_display_text(l.last_name),
      outreach_private.lead_display_text(concat_ws(' ',l.first_name,l.last_name)),
      outreach_private.lead_display_text(l.company),nullif(outreach_private.lead_display_text(l.job_title),''),nullif(outreach_private.lead_display_text(l.location),''),
      l.email,l.email_verification,l.linkedin_url,l.linkedin_verified,l.role_category,l.status,null::text,null::timestamptz,
      l.priority_rank,l.fit_reason,l.reviewed_at,l.review_evidence
    from public.outreach_imported_leads l join public.outreach_lead_lists s on s.id=l.list_id and s.client_id=l.client_id
    where l.client_id=p_client_id and l.review_state='client'
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
      case when p_sort='priority' then b.priority_rank end asc nulls last,
      case p_sort when 'priority' then nullif(lower(b.company),'') when 'company' then nullif(lower(b.company),'') when 'role' then nullif(lower(b.job_title),'') else nullif(lower(b.full_name),'') end nulls last,
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
      and (exists(select 1 from public.outreach_imported_leads visible where visible.list_id=s.id and visible.client_id=s.client_id and visible.review_state='client')
        or not exists(select 1 from public.outreach_imported_leads any_row where any_row.list_id=s.id and any_row.client_id=s.client_id))
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
    ) || outreach_private.lead_research_projection(r.priority_rank,r.fit_reason,r.reviewed_at,r.review_evidence) order by r.row_no) from page_rows r),'[]'::jsonb),
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

create function public.list_outreach_escrow_leads(p_client_id uuid,p_q text default '',p_page integer default 1)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare result jsonb;
begin
  if auth.uid() is null or p_client_id is null or not coalesce(outreach_private.workspace_role(p_client_id) in ('agency_owner','operator'),false) then
    raise exception 'Lead review access denied' using errcode='42501';
  end if;
  if p_q is null or length(p_q)>200 or p_page is null or p_page<1 or p_page>1000000 then
    raise exception 'Invalid lead filters' using errcode='22023';
  end if;
  with base as materialized (
    select l.*,outreach_private.lead_display_text(s.name) as list_name,
      outreach_private.lead_display_text(concat_ws(' ',l.first_name,l.last_name)) as full_name
    from public.outreach_imported_leads l join public.outreach_lead_lists s on s.id=l.list_id and s.client_id=l.client_id
    where l.client_id=p_client_id and l.review_state='escrow'
  ), filtered as materialized (
    select * from base b where outreach_private.lead_display_text(p_q)=''
      or strpos(lower(concat_ws(' ',b.first_name,b.last_name,b.company,b.job_title,b.location,b.email,b.linkedin_url,b.list_name,b.review_reason)),lower(outreach_private.lead_display_text(p_q)))>0
  ), totals as (
    select count(*) as n,least(p_page::bigint,greatest(1,(count(*)+35)/36))::integer as page from filtered
  ), ordered as (
    select b.*,row_number() over(order by nullif(lower(outreach_private.lead_display_text(b.company)),'') nulls last,lower(b.full_name),lower(b.email),b.id) as row_no from filtered b
  ), page_rows as (
    select o.* from ordered o cross join totals t where o.row_no>(t.page::bigint-1)*36 and o.row_no<=t.page::bigint*36
  )
  select jsonb_build_object(
    'clientId',p_client_id,
    'leads',coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.id,'clientId',r.client_id,'campaignId',null,'campaignName',null,'listId',r.list_id,'listName',r.list_name,
      'firstName',outreach_private.lead_display_text(r.first_name),'lastName',outreach_private.lead_display_text(r.last_name),
      'fullName',r.full_name,'company',outreach_private.lead_display_text(r.company),'jobTitle',nullif(outreach_private.lead_display_text(r.job_title),''),
      'location',nullif(outreach_private.lead_display_text(r.location),''),'email',r.email,'emailVerification',r.email_verification,
      'linkedinUrl',r.linkedin_url,'linkedinVerified',r.linkedin_verified,'status',r.status,'interest',null,'lastActivityAt',null,
      'reviewState','escrow','reviewReason',r.review_reason,'reviewedAt',r.reviewed_at
    ) || outreach_private.lead_research_projection(r.priority_rank,r.fit_reason,r.reviewed_at,r.review_evidence) order by r.row_no) from page_rows r),'[]'::jsonb),
    'total',t.n,'page',t.page,'pageSize',36,
    'summary',jsonb_build_object('escrow',(select count(*) from base),
      'clientVisible',(select count(*) from public.outreach_imported_leads l where l.client_id=p_client_id and l.review_state='client'))
  ) into result from totals t;
  return result;
end;
$$;
revoke all on function public.list_outreach_escrow_leads(uuid,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.list_outreach_escrow_leads(uuid,text,integer) to authenticated;
