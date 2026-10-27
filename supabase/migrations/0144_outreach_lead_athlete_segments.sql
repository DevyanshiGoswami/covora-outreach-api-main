begin;

-- Segments describe supported profile facts, never eligibility or permission to contact.
create function outreach_private.athlete_review_sources(input jsonb) returns jsonb
language sql immutable set search_path=pg_catalog,public,pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('url',url,'title',title,'fact',fact,'checkedAt',checked_at) order by ordinal),'[]'::jsonb)
  from (
    select item->>'url' url,
      left(btrim(regexp_replace(item->>'title','[[:cntrl:][:space:]]+',' ','g')),300) title,
      left(btrim(regexp_replace(item->>'fact','[[:cntrl:][:space:]]+',' ','g')),800) fact,
      item->>'checkedAt' checked_at,ordinal
    from jsonb_array_elements(case when jsonb_typeof(input)='array' then input else '[]'::jsonb end) with ordinality items(item,ordinal)
    where jsonb_typeof(item)='object' and jsonb_typeof(item->'url')='string'
      and jsonb_typeof(item->'title')='string' and jsonb_typeof(item->'fact')='string' and btrim(item->>'fact')<>''
      and length(item->>'url')<=1999
      and (item->>'url') ~ '^https://([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}(/[^[:space:]?#]*)?$'
      and (item->>'url') !~* '^https://([^/]+\.)?(localhost|local|internal)(/|$)'
      and jsonb_typeof(item->'checkedAt')='string' and length(item->>'checkedAt')<=50
      and (item->>'checkedAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
      and pg_input_is_valid(item->>'checkedAt','timestamp with time zone')
    order by ordinal limit 10
  ) safe_sources;
$$;
revoke all on function outreach_private.athlete_review_sources(jsonb) from public,anon,authenticated,service_role;

create function outreach_private.lead_athlete_segments(evidence jsonb) returns jsonb
language sql immutable set search_path=pg_catalog,public,pg_temp as $$
  with review as (
    select case when jsonb_typeof(evidence->'athleteSegmentReview')='object'
      and evidence #>> '{athleteSegmentReview,status}' in ('reviewed','needs_review')
      then evidence->'athleteSegmentReview' else '{}'::jsonb end data
  ), candidate_tags as (
    select distinct on (item->>'tag') item->>'tag' tag,
      left(btrim(regexp_replace(item->>'rationale','[[:cntrl:][:space:]]+',' ','g')),2000) rationale,
      outreach_private.athlete_review_sources(item->'sources') sources
    from review cross join lateral jsonb_array_elements(case when jsonb_typeof(data->'tagEvidence')='array' then data->'tagEvidence' else '[]'::jsonb end) with ordinality items(item,ordinal)
    where data->>'status'='reviewed' and jsonb_typeof(data->'tags')='array'
      and jsonb_typeof(item)='object' and jsonb_typeof(item->'tag')='string'
      and item->>'tag' in ('currently_in_sales','current_student_athlete','former_athlete','career_transition')
      and data->'tags' ? (item->>'tag')
      and jsonb_typeof(item->'rationale')='string' and btrim(item->>'rationale')<>''
      and jsonb_array_length(outreach_private.athlete_review_sources(item->'sources'))>0
    order by item->>'tag',ordinal
  )
  select jsonb_build_object(
    'tags',coalesce((select jsonb_agg(tag order by tag) from candidate_tags),'[]'::jsonb),
    'tagEvidence',coalesce((select jsonb_agg(jsonb_build_object('tag',tag,'rationale',rationale,'sources',sources) order by tag) from candidate_tags),'[]'::jsonb),
    'rationale',case when jsonb_typeof(data->'rationale')='string' then left(btrim(regexp_replace(data->>'rationale','[[:cntrl:][:space:]]+',' ','g')),2000) else '' end,
    'gaps',coalesce((select jsonb_agg(value order by ordinal) from (
      select left(btrim(regexp_replace(item #>> '{}','[[:cntrl:][:space:]]+',' ','g')),500) value,ordinal
      from jsonb_array_elements(case when jsonb_typeof(data->'qualificationGaps')='array' then data->'qualificationGaps' else '[]'::jsonb end) with ordinality items(item,ordinal)
      where jsonb_typeof(item)='string' and btrim(item #>> '{}')<>'' order by ordinal limit 12
    ) safe_gaps),'[]'::jsonb),
    'sources',outreach_private.athlete_review_sources(data->'sources'),
    'reviewedAt',case when jsonb_typeof(data->'researchedAt')='string' and length(data->>'researchedAt')<=50
      and (data->>'researchedAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
      and pg_input_is_valid(data->>'researchedAt','timestamp with time zone') then data->>'researchedAt' end
  ) from review;
$$;
revoke all on function outreach_private.lead_athlete_segments(jsonb) from public,anon,authenticated,service_role;

drop function public.list_outreach_leads_v2(uuid,text,text,text,uuid,text,text,text,text,integer,uuid,text,text,text,uuid,text);
create function public.list_outreach_leads_v2(
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
  p_list uuid default null,
  p_audience text default 'all',
  p_state text default '',
  p_city text default '',
  p_plan uuid default null,
  p_tier text default 'all',
  p_athlete_status text default 'all'
) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare result jsonb; selected_plan jsonb; tier_enabled boolean := p_client_id='26a2cffb-47f4-4231-9195-b4f772751c6d'::uuid;
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
    or p_audience is null or p_audience not in ('all','hiring_partners','athletes')
    or p_athlete_status is null or p_athlete_status not in ('all','currently_in_sales','current_student_athlete','former_athlete','career_transition','unassigned')
    or p_tier is null or p_tier not in ('all','1','2','3','unassigned')
    or p_state is null or length(p_state)>250 or p_state ~ '[[:cntrl:]]'
    or p_city is null or length(p_city)>250 or p_city ~ '[[:cntrl:]]'
    or p_page is null or p_page < 1 or p_page > 1000000 then
    raise exception 'Invalid lead filters' using errcode = '22023';
  end if;

  if p_plan is not null then
    select outreach_private.campaign_plan_projection(to_jsonb(p) || jsonb_build_object('name',outreach_private.lead_display_text(p.name),'lead_count',0)) into selected_plan
    from public.outreach_campaign_plans p where p.id=p_plan and p.client_id=p_client_id;
    if selected_plan is null then raise exception using errcode='42501',message='Campaign plan access denied'; end if;
  end if;

  -- This single snapshot scopes rows, counts and filter choices to the same
  -- authorized client. All user values are parameters, never dynamic SQL.
  with plan_members as materialized (
    select membership.lead_id
    from outreach_private.eligible_campaign_plan_members(p_client_id,p_plan) membership
    where p_plan is not null
  ), raw_base as materialized (
    select l.id, l.client_id, l.campaign_id, array[l.campaign_id] as campaign_ids, outreach_private.lead_display_text(c.name) as campaign_name, null::uuid as list_id, null::text as list_name,
      outreach_private.lead_display_text(l.first_name) as first_name, outreach_private.lead_display_text(l.last_name) as last_name,
      outreach_private.lead_display_text(concat_ws(' ',l.first_name,l.last_name)) as full_name,
      outreach_private.lead_display_text(l.company) as company, nullif(outreach_private.lead_display_text(l.job_title),'') as job_title, nullif(outreach_private.lead_display_text(l.location),'') as location,
      case when length(l.email) <= 254 and l.email !~ '[[:cntrl:]]' and l.email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then l.email else null end as email,
      case when length(l.email) <= 254 and l.email !~ '[[:cntrl:]]' and l.email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then case when l.status in ('bounced','unsubscribed') then 'unverified' else l.email_verification end else 'unknown' end as email_verification,
      l.linkedin_url, l.linkedin_verified,
      l.role_category, case when l.status in ('not_contacted','in_sequence','contacted','replied','completed','bounced','unsubscribed','skipped','paused') then l.status else 'unknown' end as status,
      nullif(outreach_private.lead_display_text(l.interest),'') as interest, l.last_activity_at,
      null::integer as priority_rank, null::text as fit_reason, null::timestamptz as reviewed_at, '{}'::jsonb as review_evidence, l.status='bounced' as email_bounced
    from public.outreach_leads l
    join public.outreach_campaigns c on c.id = l.campaign_id and c.client_id = l.client_id
    where p_plan is null and l.client_id = p_client_id and c.channel='email'
      and not exists(select 1 from public.outreach_imported_leads original where original.client_id=l.client_id and (
        nullif(lower(btrim(original.email)),'')=nullif(lower(btrim(l.email)),'')
        or nullif(lower(rtrim(original.linkedin_url,'/')),'')=nullif(lower(rtrim(l.linkedin_url,'/')),'')
      ))
    union all
    select l.id,l.client_id,live.campaign_id,coalesce(live.campaign_ids,'{}'::uuid[]),nullif(outreach_private.lead_display_text(live.campaign_name),''),l.list_id,outreach_private.lead_display_text(s.name),
      outreach_private.lead_display_text(l.first_name),outreach_private.lead_display_text(l.last_name),
      outreach_private.lead_display_text(concat_ws(' ',l.first_name,l.last_name)),
      outreach_private.lead_display_text(l.company),nullif(outreach_private.lead_display_text(l.job_title),''),nullif(outreach_private.lead_display_text(l.location),''),
      l.email,case when live.suppressed_email then 'unverified' else l.email_verification end,
      l.linkedin_url,l.linkedin_verified,l.role_category,
      case when live.status in ('not_contacted','in_sequence','contacted','replied','completed','bounced','unsubscribed','skipped','paused') then live.status
        when live.campaign_id is not null then 'unknown' else l.status end,
      nullif(outreach_private.lead_display_text(live.interest),''),live.last_activity_at,
      l.priority_rank,l.fit_reason,l.reviewed_at,l.review_evidence,coalesce(live.email_bounced,false)
    from public.outreach_imported_leads l join public.outreach_lead_lists s on s.id=l.list_id and s.client_id=l.client_id
    left join lateral (
      select m.campaign_id,c.name as campaign_name,m.status,m.interest,
        max(m.last_activity_at) over() as last_activity_at,array_agg(m.campaign_id) over() as campaign_ids,
        bool_or(m.status='bounced' and nullif(lower(btrim(m.email)),'')=nullif(lower(btrim(l.email)),'')) over() as email_bounced,
        bool_or(m.status in ('bounced','unsubscribed') and nullif(lower(btrim(m.email)),'')=nullif(lower(btrim(l.email)),'')) over() as suppressed_email
      from public.outreach_leads m join public.outreach_campaigns c on c.id=m.campaign_id and c.client_id=m.client_id and c.channel='email'
      where m.client_id=l.client_id and (
        nullif(lower(btrim(m.email)),'')=nullif(lower(btrim(l.email)),'')
        or nullif(lower(rtrim(m.linkedin_url,'/')),'')=nullif(lower(rtrim(l.linkedin_url,'/')),'')
      )
      order by (m.campaign_id=p_campaign) desc nulls last,case m.status when 'unsubscribed' then 0 when 'bounced' then 1 when 'replied' then 2
        when 'completed' then 3 when 'contacted' then 4 when 'in_sequence' then 5 else 6 end,
        m.last_activity_at desc nulls last,m.id
      limit 1
    ) live on true
    where l.client_id=p_client_id and l.review_state='client'
      and (p_plan is null or l.id in (select membership.lead_id from plan_members membership))
  ), classified as materialized (
    select b.*,outreach_private.lead_audience(b.review_evidence,b.list_name) as audience,
      outreach_private.lead_person_location(b.review_evidence) as person_location
    from raw_base b
  ), base as materialized (
    select b.*,
      case when tier_enabled and b.audience='athletes' then outreach_private.lead_athlete_segments(b.review_evidence) end as athlete_segments,
      case when tier_enabled and b.audience='hiring_partners' then outreach_private.lead_hiring_tier(b.review_evidence) end as hiring_tier,
      case when b.person_location->>'state' is not null then concat(b.person_location->>'country','|',b.person_location->>'state') end as state_key,
      case when b.person_location->>'city' is not null then concat(b.person_location->>'country','|',b.person_location->>'state','|',b.person_location->>'city') end as city_key
    from classified b
    where p_plan is null or b.id in (select membership.lead_id from plan_members membership)
  ), nonlocation_filtered as materialized (
    select * from base b
    where (outreach_private.lead_display_text(p_q) = '' or strpos(lower(concat_ws(' ',b.first_name,b.last_name,b.company,b.job_title,b.location,b.email,b.linkedin_url,b.campaign_name,b.list_name)),lower(outreach_private.lead_display_text(p_q))) > 0)
      and (p_role = 'all' or coalesce(b.role_category,'manager-other') = p_role)
      and (outreach_private.lead_display_text(p_company) = '' or lower(b.company) = lower(outreach_private.lead_display_text(p_company)))
      and (p_campaign is null or p_campaign=any(b.campaign_ids))
      and (p_list is null or b.list_id = p_list)
      and (p_email = 'all' or p_email = 'available' and b.email is not null or p_email = 'verified' and b.email is not null and b.email_verification = 'verified')
      and (p_linkedin = 'all' or p_linkedin = 'available' and b.linkedin_url is not null or p_linkedin = 'verified' and b.linkedin_url is not null and b.linkedin_verified is true)
      and (p_status = 'all' or p_status = b.status or p_status = 'contacted' and b.status = 'in_sequence')
      and (p_audience='all' or b.audience=p_audience)
      and (p_athlete_status='all' or tier_enabled and b.audience='athletes'
        and (p_athlete_status='unassigned' and jsonb_array_length(b.athlete_segments->'tags')=0 or b.athlete_segments->'tags' ? p_athlete_status))
      and (p_tier='all' or tier_enabled and b.audience='hiring_partners'
        and (p_tier='unassigned' and b.hiring_tier is null or b.hiring_tier::text=p_tier))
  ), filtered as materialized (
    select * from nonlocation_filtered b
    where (p_state='' or b.state_key=p_state) and (p_city='' or b.city_key=p_city)
  ), states as materialized (
    select state_key as value,concat(person_location->>'state',', ',person_location->>'country') as label,count(*) as n
    from nonlocation_filtered where state_key is not null group by state_key,person_location->>'state',person_location->>'country'
  ), state_options as (
    select * from (select * from states order by lower(label),value limit 1000) first_options
    union select * from states where value=p_state
  ), cities as materialized (
    select city_key as value,concat_ws(', ',person_location->>'city',person_location->>'state',person_location->>'country') as label,count(*) as n
    from nonlocation_filtered where city_key is not null and (p_state='' or state_key=p_state)
    group by city_key,person_location->>'city',person_location->>'state',person_location->>'country'
  ), city_options as (
    select * from (select * from cities order by lower(label),value limit 5000) first_options
    union select * from cities where value=p_city
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
    select distinct c.id,outreach_private.lead_display_text(c.name) as name from base b
      join public.outreach_campaigns c on c.client_id=b.client_id and c.id=any(b.campaign_ids) and c.channel='email'
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
      'jobTitle',r.job_title,'location',r.location,'audience',r.audience,'personLocation',r.person_location,
      'icebreaker',outreach_private.lead_icebreaker(r.review_evidence),'email',r.email,'emailVerification',r.email_verification,
      'linkedinUrl',r.linkedin_url,'linkedinVerified',r.linkedin_verified,'status',r.status,
      'interest',r.interest,'lastActivityAt',r.last_activity_at
    ) || outreach_private.lead_research_projection(r.priority_rank,r.fit_reason,r.reviewed_at,r.review_evidence)
      || outreach_private.lead_email_recovery_projection(r.email,r.email_verification,r.linkedin_url,r.review_evidence)
      || case when tier_enabled and r.audience='hiring_partners' then jsonb_build_object('hiringTier',r.hiring_tier) || outreach_private.lead_hiring_tier_evidence(r.review_evidence) else '{}'::jsonb end
      || case when tier_enabled and r.audience='athletes' then jsonb_build_object('athleteSegments',r.athlete_segments) else '{}'::jsonb end
      || case when r.email_bounced then jsonb_build_object('emailValidation','invalid') else '{}'::jsonb end order by r.row_no) from page_rows r),'[]'::jsonb),
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
    'tierEnabled',tier_enabled,
    'athleteSegmentsEnabled',tier_enabled,
    'audienceEnabled',p_client_id='26a2cffb-47f4-4231-9195-b4f772751c6d'::uuid and exists(select 1 from base where audience is not null),
    'locationOptions',jsonb_build_object(
      'states',coalesce((select jsonb_agg(jsonb_build_object('value',value,'label',label,'count',n) order by lower(label),value) from state_options),'[]'::jsonb),
      'cities',coalesce((select jsonb_agg(jsonb_build_object('value',value,'label',label,'count',n) order by lower(label),value) from city_options),'[]'::jsonb)
    ),
    'filterOptionsTruncated',(select count(*)>1000 from states) or (select count(*)>5000 from cities) or (select count(*) > 1000 from companies) or (select count(*) > 500 from campaigns) or (select count(*) > 500 from lists)
  ) into result from totals t;
  return result || case when p_plan is not null then jsonb_build_object('selectedPlan',
    jsonb_set(selected_plan,'{leadCount}',result->'summary'->'total')) else '{}'::jsonb end;
end;
$$;
revoke all on function public.list_outreach_leads_v2(uuid,text,text,text,uuid,text,text,text,text,integer,uuid,text,text,text,uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.list_outreach_leads_v2(uuid,text,text,text,uuid,text,text,text,text,integer,uuid,text,text,text,uuid,text,text) to authenticated;




notify pgrst,'reload schema';
commit;
