-- Diagnostic record of each provider HTTP call made while connecting accounts or checking keys:
-- status, timing, the provider's request ID and a masked, bounded error excerpt. It never holds
-- keys, cookies, passwords, PINs, request bodies or mailbox addresses. Server-only.
create table public.outreach_provider_calls (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  source text not null check (source in ('connection','email_review','integration_check','probe')),
  connection_id uuid references public.outreach_connections(id) on delete cascade,
  integration_id text check (integration_id is null or length(integration_id) between 1 and 100),
  channel text not null check (channel in ('email','linkedin')),
  method text not null check (method in ('GET','POST')),
  operation text not null check (length(operation) between 1 and 200),
  http_status integer check (http_status is null or http_status between 100 and 599),
  outcome text not null check (outcome in ('ok','http_error','network_error','timeout')),
  duration_ms integer not null check (duration_ms >= 0),
  request_id text check (request_id is null or length(request_id) <= 200),
  error_excerpt text check (error_excerpt is null or length(error_excerpt) <= 410)
);
create index outreach_provider_calls_created_idx on public.outreach_provider_calls (created_at desc);
create index outreach_provider_calls_connection_idx on public.outreach_provider_calls (connection_id) where connection_id is not null;
alter table public.outreach_provider_calls enable row level security;
revoke all on public.outreach_provider_calls from public,anon,authenticated,service_role;
grant select,insert,delete on public.outreach_provider_calls to service_role;
