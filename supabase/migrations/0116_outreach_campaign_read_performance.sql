-- Resolve active, feature-enabled workspaces once per statement for campaign reads.
-- Preserve auth.uid(), tenant/channel scope, projections, grants and public views.

create or replace function outreach_private.read_campaigns() returns table(id uuid,client_id uuid,name text,status text,schedule jsonb,totals jsonb,synced_at timestamptz,completed_at timestamptz,created_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  with allowed_workspaces as materialized (
    select w.client_id from outreach_private.read_workspaces() w
  )
  select c.id,c.client_id,c.name,c.status,outreach_private.schedule(c.schedule),
    outreach_private.metrics(c.totals,array['leads','contacted','sent','unique_opened','unique_replies','unique_auto_replies','bounced','unsubscribed','completed','opportunities','positive_replies','unique_clicks'])
      || case when jsonb_typeof(c.totals->'analytics_available')='boolean'
        then jsonb_build_object('analytics_available',c.totals->'analytics_available')
        else '{}'::jsonb end,
    c.synced_at,c.completed_at,c.created_at
  from public.outreach_campaigns c join allowed_workspaces w on w.client_id=c.client_id
  where c.channel='email';
$$;

create or replace function outreach_private.read_campaign_steps() returns table(campaign_id uuid,client_id uuid,step integer,variant integer,subject text,body_text text,delay_days numeric,stats jsonb)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  with allowed_workspaces as materialized (
    select w.client_id from outreach_private.read_workspaces() w
  )
  select c.campaign_id,c.client_id,c.step,c.variant,c.subject,c.body_text,c.delay_days,outreach_private.metrics(c.stats,array['sent','contacted','unique_opened','unique_replies','unique_auto_replies','unique_clicks','opportunities']) from public.outreach_campaign_steps c join allowed_workspaces w on w.client_id=c.client_id where exists(select 1 from public.outreach_campaigns assignment where assignment.id=c.campaign_id and assignment.client_id=c.client_id and assignment.channel='email');
$$;

create or replace function outreach_private.read_campaign_daily() returns table(campaign_id uuid,client_id uuid,day date,sent bigint,contacted bigint,new_contacted bigint,unique_opened bigint,unique_replies bigint,auto_replies bigint,unique_clicks bigint,opportunities bigint)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  with allowed_workspaces as materialized (
    select w.client_id from outreach_private.read_workspaces() w
  )
  select c.campaign_id,c.client_id,c.day,c.sent,c.contacted,c.new_contacted,c.unique_opened,c.unique_replies,c.auto_replies,c.unique_clicks,c.opportunities from public.outreach_campaign_daily c join allowed_workspaces w on w.client_id=c.client_id where exists(select 1 from public.outreach_campaigns assignment where assignment.id=c.campaign_id and assignment.client_id=c.client_id and assignment.channel='email');
$$;

create or replace function outreach_private.read_leads() returns table(id uuid,campaign_id uuid,client_id uuid,email text,first_name text,last_name text,company text,status text,last_step integer,reply_count integer,interest text,last_activity_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  with allowed_workspaces as materialized (
    select w.client_id from outreach_private.read_workspaces() w
  )
  select c.id,c.campaign_id,c.client_id,c.email,c.first_name,c.last_name,c.company,c.status,c.last_step,c.reply_count,c.interest,c.last_activity_at from public.outreach_leads c join allowed_workspaces w on w.client_id=c.client_id where exists(select 1 from public.outreach_campaigns assignment where assignment.id=c.campaign_id and assignment.client_id=c.client_id and assignment.channel='email');
$$;
