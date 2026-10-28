-- Email agencies may serve distinct clients from one provider workspace. Each
-- tenant still owns its bindings, campaigns and exclusive sender identities.
-- No configuration rows, campaigns, access grants or activation are seeded.
do $$ begin
  lock table public.outreach_account_workspaces,public.outreach_reply_workspaces in share row exclusive mode;
  if exists (
    select credential_ref from (
      select credential_ref,remote_workspace_id::text as remote_workspace_id from public.outreach_account_workspaces
      union all
      select credential_ref,remote_workspace_id from public.outreach_reply_workspaces where channel='email'
    ) bindings group by credential_ref having count(distinct remote_workspace_id)>1
  ) then
    raise exception using errcode='22023',message='Existing email credential has conflicting workspaces';
  end if;
end; $$;

alter table public.outreach_account_workspaces
  drop constraint outreach_account_workspaces_remote_workspace_id_key,
  drop constraint outreach_account_workspaces_credential_ref_key;
create index outreach_account_workspace_credential on public.outreach_account_workspaces(credential_ref);

alter table public.outreach_reply_workspaces
  drop constraint outreach_reply_workspaces_channel_remote_workspace_id_key,
  drop constraint outreach_reply_workspaces_credential_ref_key;
create unique index outreach_linkedin_workspace_identity on public.outreach_reply_workspaces(remote_workspace_id) where channel='linkedin';
create unique index outreach_linkedin_workspace_credential on public.outreach_reply_workspaces(credential_ref) where channel='linkedin';
create index outreach_email_workspace_credential on public.outreach_reply_workspaces(credential_ref) where channel='email';

-- A durable row is a mutex, not an authorization record. Unlike an advisory
-- lock alone, updating it makes a conflicting REPEATABLE READ/SERIALIZABLE
-- transaction fail with a serialization error instead of checking a stale
-- cross-table snapshot. Unused references may remain; they grant no access.
create table outreach_private.email_credential_guards (
  credential_ref text primary key
);
alter table outreach_private.email_credential_guards enable row level security;
revoke all on outreach_private.email_credential_guards from public,anon,authenticated,service_role;

create function outreach_private.guard_email_workspace_credential() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare own_client_id uuid;
begin
  own_client_id:=case when tg_op='UPDATE' then old.client_id else new.client_id end;
  insert into outreach_private.email_credential_guards(credential_ref) values(new.credential_ref)
    on conflict(credential_ref) do update set credential_ref=excluded.credential_ref;

  -- Keep this query separate from the UPSERT so READ COMMITTED sees writes
  -- committed while waiting for the credential guard. Exclude only this table's
  -- own binding, including the BEFORE INSERT phase of a configuration UPSERT.
  if exists(select 1 from public.outreach_account_workspaces w
    where w.credential_ref=new.credential_ref and w.remote_workspace_id::text<>new.remote_workspace_id::text
      and not (tg_table_name='outreach_account_workspaces' and w.client_id=own_client_id))
    or exists(select 1 from public.outreach_reply_workspaces w
    where w.channel='email' and w.credential_ref=new.credential_ref and w.remote_workspace_id<>new.remote_workspace_id::text
      and not (tg_table_name='outreach_reply_workspaces' and w.client_id=own_client_id)) then
    raise exception using errcode='22023',message='Email credential workspace mismatch';
  end if;
  return new;
end; $$;
revoke all on function outreach_private.guard_email_workspace_credential() from public,anon,authenticated,service_role;
create trigger outreach_account_workspace_credential before insert or update of credential_ref,remote_workspace_id
  on public.outreach_account_workspaces for each row execute function outreach_private.guard_email_workspace_credential();
create trigger outreach_reply_workspace_credential before insert or update of credential_ref,remote_workspace_id
  on public.outreach_reply_workspaces for each row when(new.channel='email') execute function outreach_private.guard_email_workspace_credential();

notify pgrst,'reload schema';
