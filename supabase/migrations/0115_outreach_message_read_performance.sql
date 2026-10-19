-- Authorize once per workspace in this statement, rather than once per message.
-- The existing workspace helper still checks auth.uid(), active memberships and
-- the outreach feature gate. Nothing is cached across requests or users.
create or replace function outreach_private.read_messages()
returns table(id uuid,campaign_id uuid,client_id uuid,thread_key uuid,direction text,lead_email text,from_email text,to_email text,subject text,body_text text,sent_at timestamptz,interest text,is_auto_reply boolean,client_read_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  with allowed_workspaces as materialized (
    select w.client_id from outreach_private.read_workspaces() w
  )
  select c.id,c.campaign_id,c.client_id,c.thread_key,c.direction,c.lead_email,
    c.from_email,c.to_email,c.subject,c.body_text,c.sent_at,c.interest,
    c.is_auto_reply,c.client_read_at
  from public.outreach_messages c
  join allowed_workspaces w on w.client_id=c.client_id
  where exists (
    select 1 from public.outreach_campaigns assignment
    where assignment.id=c.campaign_id and assignment.client_id=c.client_id
      and assignment.channel='email'
  );
$$;
-- CREATE OR REPLACE preserves the existing authenticated execute grant and
-- the security-invoker/security-barrier public view. Base tables stay private.
