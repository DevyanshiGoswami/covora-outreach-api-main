-- Independent outbound identity and tenant foundation; no content-portal roles.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
alter default privileges in schema public revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema public revoke all on sequences from public,anon,authenticated,service_role;
alter default privileges in schema public revoke all on functions from public,anon,authenticated,service_role;
create function public.set_updated_at() returns trigger language plpgsql
set search_path=pg_catalog,public,pg_temp as $$ begin new.updated_at:=clock_timestamp();return new;end;$$;
revoke all on function public.set_updated_at() from public,anon,authenticated,service_role;
create table public.clients(
 id uuid primary key default gen_random_uuid(),
 slug text not null unique check(slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
 name text not null check(length(name) between 1 and 200),
 created_at timestamptz not null default clock_timestamp()
);
create table public.client_features(
 client_id uuid not null references public.clients(id) on delete cascade,
 feature text not null check(feature='outreach_app'),
 enabled boolean not null default false,
 config jsonb not null default '{}'::jsonb,
 primary key(client_id,feature)
);
-- Names are presentation only; this table confers no product or tenant role.
create table public.profiles(
 id uuid primary key references auth.users(id) on delete cascade,
 full_name text not null default '' check(length(full_name)<=200)
);
alter table public.clients enable row level security;
alter table public.client_features enable row level security;
alter table public.profiles enable row level security;
create policy clients_service on public.clients for all to service_role using(true) with check(true);
create policy client_features_service on public.client_features for all to service_role using(true) with check(true);
create policy profiles_service on public.profiles for all to service_role using(true) with check(true);
revoke all on public.clients,public.client_features,public.profiles from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.clients,public.client_features,public.profiles to service_role;
