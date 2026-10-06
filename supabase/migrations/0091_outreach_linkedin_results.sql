-- Extracted for the independent outbound platform; see docs/schema-extraction.md.
-- Independent service-owned activity cohorts; no content-portal logs or inferred outcomes.
create table public.outreach_linkedin_activity(
 client_id uuid not null references public.clients(id) on delete cascade,
 day date not null,
 source text not null check(source in ('outreach_log','dm_log')),
 sent bigint not null check(sent>=0),
 replied bigint check(replied>=0),
 meeting_booked bigint check(meeting_booked>=0),
 primary key(client_id,day,source),
 check(source<>'outreach_log' or (replied is null and meeting_booked is null))
);
alter table public.outreach_linkedin_activity enable row level security;
create policy outreach_linkedin_activity_service on public.outreach_linkedin_activity for all to service_role using(true) with check(true);
revoke all on public.outreach_linkedin_activity from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.outreach_linkedin_activity to service_role;
create function outreach_private.read_linkedin_daily()
returns table(client_id uuid,day date,source text,sent bigint,replied bigint,meeting_booked bigint)
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select a.client_id,a.day,a.source,a.sent,a.replied,a.meeting_booked
 from public.outreach_linkedin_activity a where outreach_private.can_read(a.client_id);
$$;
revoke all on function outreach_private.read_linkedin_daily() from public,anon,authenticated,service_role;
grant execute on function outreach_private.read_linkedin_daily() to authenticated;
create view public.client_outreach_linkedin_daily with(security_invoker=true,security_barrier=true)
 as select * from outreach_private.read_linkedin_daily();
revoke all on public.client_outreach_linkedin_daily from public,anon,authenticated,service_role;
grant select on public.client_outreach_linkedin_daily to authenticated;
comment on view public.client_outreach_linkedin_daily is 'Independent UTC activity cohorts. Empty until dedicated service ingestion; NULL means unavailable. Sources may overlap and must not be summed as unique sends.';
notify pgrst,'reload schema';
