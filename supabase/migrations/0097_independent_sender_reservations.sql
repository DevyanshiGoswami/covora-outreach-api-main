-- Reserve email identities only inside this product. Both paths use the same
-- advisory namespace so a concurrent account/sender insert cannot cross tenants.
create or replace function outreach_private.guard_account_reservation() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if tg_op='UPDATE' and (new.email is distinct from old.email or new.client_id is distinct from old.client_id or new.id is distinct from old.id) then
    raise exception using errcode='22023',message='Account identity cannot change';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.email,913));
  if exists(select 1 from public.outreach_reply_senders s where s.channel='email'
    and s.remote_sender_id=new.email and s.client_id<>new.client_id) then
    raise exception using errcode='22023',message='Account registration unavailable';
  end if;
  return new;
end; $$;
revoke all on function outreach_private.guard_account_reservation() from public,anon,authenticated,service_role;

create or replace function outreach_private.validate_reply_sender() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if new.channel='email' then
    if new.remote_sender_id<>outreach_private.account_email(new.remote_sender_id)
      or new.sender_address<>new.remote_sender_id then
      raise exception using errcode='22023',message='Sender address must be canonical';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(new.remote_sender_id,913));
    if exists(select 1 from public.outreach_accounts a where a.email=new.remote_sender_id and a.client_id<>new.client_id) then
      raise exception using errcode='23505',message='Sender unavailable';
    end if;
  end if;
  return new;
end; $$;
revoke all on function outreach_private.validate_reply_sender() from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
