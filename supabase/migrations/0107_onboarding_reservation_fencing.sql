-- Final uniqueness is authoritative even when two independent client transactions
-- observe an unreserved remote LinkedIn identity at the same time.
create unique index outreach_connection_verified_identity on public.outreach_connections(channel,remote_account)
  where state='connected';

create function outreach_private.guard_connection_completion() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if new.state='connected' and new.channel='linkedin' then
    if not exists(select 1 from public.outreach_reply_senders where channel='linkedin'
      and remote_sender_id=new.remote_account and client_id=new.client_id) then
      raise exception using errcode='22023',message='Account unavailable';
    end if;
  end if;
  if tg_op='INSERT' then
    -- The prepare command already holds the per-client lock. Bound attempts even
    -- when a client admin creates many people or uses the RPC directly.
    if (select count(*) from public.outreach_connections where client_id=new.client_id and created_at>clock_timestamp()-interval '1 minute')>=5 then
      raise exception using errcode='22023',message='Wait before starting another connection';
    end if;
  end if;
  return new;
end; $$;
revoke all on function outreach_private.guard_connection_completion() from public,anon,authenticated,service_role;
create trigger outreach_connection_guard before insert or update on public.outreach_connections
  for each row execute function outreach_private.guard_connection_completion();
notify pgrst,'reload schema';
