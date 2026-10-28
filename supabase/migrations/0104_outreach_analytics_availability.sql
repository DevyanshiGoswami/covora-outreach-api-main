-- Preserve explicit analytics availability without widening numeric projections
-- or exposing any raw provider JSON through the neutral campaign view.
create or replace function outreach_private.read_campaigns() returns table(id uuid,client_id uuid,name text,status text,schedule jsonb,totals jsonb,synced_at timestamptz,completed_at timestamptz,created_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select c.id,c.client_id,c.name,c.status,outreach_private.schedule(c.schedule),
    outreach_private.metrics(c.totals,array['leads','contacted','sent','unique_opened','unique_replies','unique_auto_replies','bounced','unsubscribed','completed','opportunities','positive_replies','unique_clicks'])
      || case when jsonb_typeof(c.totals->'analytics_available')='boolean'
        then jsonb_build_object('analytics_available',c.totals->'analytics_available')
        else '{}'::jsonb end,
    c.synced_at,c.completed_at,c.created_at
  from public.outreach_campaigns c
  where c.channel='email' and outreach_private.can_read(c.client_id);
$$;
revoke all on function outreach_private.read_campaigns() from public, anon, authenticated, service_role;
grant execute on function outreach_private.read_campaigns() to authenticated;

notify pgrst, 'reload schema';
