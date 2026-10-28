-- Outbound worker observability only; no content jobs, cron schedule or email digest.
create table public.worker_heartbeats(
 name text primary key check(name ~ '^[a-z0-9-]{1,50}$'),
 last_run_at timestamptz not null default clock_timestamp(),
 last_ok_at timestamptz,
 last_result text check(last_result is null or length(last_result)<=500)
);
alter table public.worker_heartbeats enable row level security;
create policy worker_heartbeats_service on public.worker_heartbeats for all to service_role using(true) with check(true);
revoke all on public.worker_heartbeats from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.worker_heartbeats to service_role;
create function public.record_worker_heartbeat(worker_name text,succeeded boolean,result_note text default null)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 insert into public.worker_heartbeats(name,last_run_at,last_ok_at,last_result)
 values(worker_name,clock_timestamp(),case when succeeded then clock_timestamp() end,left(coalesce(result_note,''),500))
 on conflict(name) do update set last_run_at=excluded.last_run_at,
  last_ok_at=coalesce(excluded.last_ok_at,public.worker_heartbeats.last_ok_at),last_result=excluded.last_result;
end; $$;
revoke all on function public.record_worker_heartbeat(text,boolean,text) from public,anon,authenticated,service_role;
grant execute on function public.record_worker_heartbeat(text,boolean,text) to service_role;
notify pgrst,'reload schema';
