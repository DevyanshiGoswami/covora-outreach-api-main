-- Client-readable lead directory for explicitly assigned outbound campaigns.
-- The existing results projections and their contracts deliberately stay unchanged.
alter table public.outreach_leads
  add column job_title text check(job_title is null or length(job_title) <= 500),
  add column location text check(location is null or length(location) <= 500),
  add column linkedin_url text check(linkedin_url is null or linkedin_url ~ '^https://www\.linkedin\.com/in/[a-zA-Z0-9_-]{1,200}$'),
  add column email_verification text not null default 'unknown' check(email_verification in ('verified','unverified','unknown')),
  add column linkedin_verified boolean,
  add column role_category text check(role_category in ('owners-executives','vp-director','manager-other')),
  add constraint outreach_leads_linkedin_evidence check(linkedin_verified is not true or linkedin_url is not null);

create index outreach_leads_client_directory_idx on public.outreach_leads(client_id, lower(company), id);
create index outreach_leads_client_role_idx on public.outreach_leads(client_id, role_category, id);

-- Defensive normalization also covers historical service-imported rows. A bad
-- cell must not poison a page or a workspace-wide filter option.
create function outreach_private.lead_display_text(p_value text) returns text
language sql immutable set search_path = pg_catalog, public, pg_temp as $$
  select left(btrim(regexp_replace(coalesce(p_value,''),'[[:cntrl:][:space:]]+',' ','g')),500);
$$;
revoke all on function outreach_private.lead_display_text(text) from public, anon, authenticated, service_role;

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
  p_page integer default 1
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
    select l.id, l.client_id, l.campaign_id, outreach_private.lead_display_text(c.name) as campaign_name,
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
  ), filtered as materialized (
    select * from base b
    where (outreach_private.lead_display_text(p_q) = '' or strpos(lower(concat_ws(' ',b.first_name,b.last_name,b.company,b.job_title,b.location,b.email,b.linkedin_url,b.campaign_name)),lower(outreach_private.lead_display_text(p_q))) > 0)
      and (p_role = 'all' or coalesce(b.role_category,'manager-other') = p_role)
      and (outreach_private.lead_display_text(p_company) = '' or lower(b.company) = lower(outreach_private.lead_display_text(p_company)))
      and (p_campaign is null or b.campaign_id = p_campaign)
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
    select distinct b.campaign_id as id,b.campaign_name as name from base b
  ), campaign_options as (
    select * from (select id,name from campaigns order by lower(name),id limit 500) first_options
    union select id,name from campaigns where id = p_campaign
  )
  select jsonb_build_object(
    'clientId',p_client_id,
    'leads',coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.id,'clientId',r.client_id,'campaignId',r.campaign_id,'campaignName',r.campaign_name,
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
    'filterOptionsTruncated',(select count(*) > 1000 from companies) or (select count(*) > 500 from campaigns)
  ) into result from totals t;
  return result;
end;
$$;
revoke all on function public.list_outreach_leads(uuid,text,text,text,uuid,text,text,text,text,integer) from public, anon, authenticated, service_role;
grant execute on function public.list_outreach_leads(uuid,text,text,text,uuid,text,text,text,text,integer) to authenticated;
