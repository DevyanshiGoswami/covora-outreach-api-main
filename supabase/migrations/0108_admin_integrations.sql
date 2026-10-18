-- Agency configuration uses encrypted Vault secrets; no authenticated SQL role
-- can read keys or invoke credential management directly.
create extension if not exists supabase_vault with schema vault;
revoke all on all tables in schema vault from public,anon,authenticated;
revoke usage on schema vault from public,anon,authenticated;

create table public.outreach_integrations (
  id uuid primary key,
  channel text not null check(channel in ('email','linkedin')),
  label text not null check(length(btrim(label)) between 1 and 100),
  remote_workspace_id text not null check(length(remote_workspace_id) between 1 and 200),
  credential_ref text not null unique,
  secret_id uuid not null unique references vault.secrets(id),
  version bigint not null default 1 check(version>0),
  verified_at timestamptz not null default now(),
  checked_at timestamptz not null default now(),
  check_error boolean not null default false,
  created_by uuid not null,
  unique(channel,remote_workspace_id)
);
create table public.outreach_integration_audit (
  id bigint generated always as identity primary key,
  actor_id uuid not null, integration_id uuid not null,
  event text not null check(event in ('saved','checked','removed')),
  created_at timestamptz not null default now()
);
alter table public.outreach_integrations enable row level security;
alter table public.outreach_integration_audit enable row level security;
revoke all on public.outreach_integrations,public.outreach_integration_audit from public,anon,authenticated,service_role;
grant select on public.outreach_integrations,public.outreach_integration_audit to service_role;
create policy integrations_service_read on public.outreach_integrations for select to service_role using(true);
create policy integration_audit_service_read on public.outreach_integration_audit for select to service_role using(true);

create function outreach_private.lock_integration_owner(p_actor uuid,p_version bigint) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  perform 1 from public.outreach_agency_memberships where user_id=p_actor and state='active' and version=p_version for share;
  if not found then raise exception using errcode='42501',message='Integration access denied'; end if;
end; $$;
revoke all on function outreach_private.lock_integration_owner(uuid,bigint) from public,anon,authenticated,service_role;

create function public.save_outreach_integration(p_actor uuid,p_actor_version bigint,p_id uuid,p_version bigint,p_channel text,p_label text,p_workspace text,p_key text) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare old public.outreach_integrations%rowtype; secret uuid; ref text;
begin
  perform outreach_private.lock_integration_owner(p_actor,p_actor_version);
  if p_id is null or p_version is null or p_channel is null or p_channel not in ('email','linkedin')
    or p_label is null or length(btrim(p_label)) not between 1 and 100
    or p_workspace is null or length(p_workspace) not between 1 and 200
    or p_key is null or length(p_key) not between 8 and 4096 then raise invalid_parameter_value; end if;
  perform pg_advisory_xact_lock(hashtextextended('outreach-integration:'||p_id::text,0));
  select * into old from public.outreach_integrations where id=p_id for update;
  if found then
    if old.version<>p_version or old.channel<>p_channel or old.remote_workspace_id<>p_workspace then raise invalid_parameter_value; end if;
    -- A rotation must not race a pending account login. Existing identities and
    -- workspaces are immutable here; only a verified key for the same scope changes.
    if exists(select 1 from public.outreach_connections c where c.state in ('starting','pending') and (
      exists(select 1 from public.outreach_account_workspaces w where w.client_id=c.client_id and c.channel='email' and w.credential_ref=old.credential_ref)
      or exists(select 1 from public.outreach_reply_workspaces w where w.client_id=c.client_id and w.channel=c.channel and w.credential_ref=old.credential_ref)
    )) then raise exception using errcode='22023',message='Finish pending account connections before updating this key'; end if;
    perform vault.update_secret(old.secret_id,p_key);
    update public.outreach_integrations set label=btrim(p_label),version=version+1,verified_at=now(),checked_at=now(),check_error=false where id=p_id;
  else
    if p_version<>0 then raise invalid_parameter_value; end if;
    ref:='OUTREACH_'||case when p_channel='email' then 'INSTANTLY' else 'HEYREACH' end||'_VAULT_'||upper(replace(p_id::text,'-',''));
    secret:=vault.create_secret(p_key);
    insert into public.outreach_integrations(id,channel,label,remote_workspace_id,credential_ref,secret_id,created_by)
      values(p_id,p_channel,btrim(p_label),p_workspace,ref,secret,p_actor);
  end if;
  insert into public.outreach_integration_audit(actor_id,integration_id,event) values(p_actor,p_id,'saved');
exception when unique_violation then raise exception using errcode='22023',message='Workspace already configured';
end; $$;

create function public.read_outreach_integration_key(p_ref text) returns text
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select s.decrypted_secret from public.outreach_integrations i join vault.decrypted_secrets s on s.id=i.secret_id where i.credential_ref=p_ref;
$$;

create function public.check_outreach_integration(p_actor uuid,p_actor_version bigint,p_id uuid,p_version bigint,p_ok boolean) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  perform outreach_private.lock_integration_owner(p_actor,p_actor_version);
  if p_ok is null then raise invalid_parameter_value; end if;
  update public.outreach_integrations set checked_at=now(),check_error=not p_ok,verified_at=case when p_ok then now() else verified_at end
    where id=p_id and version=p_version;
  if not found then raise invalid_parameter_value; end if;
  insert into public.outreach_integration_audit(actor_id,integration_id,event) values(p_actor,p_id,'checked');
end; $$;

create function public.remove_outreach_integration(p_actor uuid,p_actor_version bigint,p_id uuid,p_version bigint) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare old public.outreach_integrations%rowtype;
begin
  perform outreach_private.lock_integration_owner(p_actor,p_actor_version);
  select * into old from public.outreach_integrations where id=p_id and version=p_version for update;
  if not found then raise invalid_parameter_value; end if;
  if exists(select 1 from public.outreach_account_workspaces where credential_ref=old.credential_ref)
    or exists(select 1 from public.outreach_reply_workspaces where credential_ref=old.credential_ref)
    then raise exception using errcode='22023',message='Connection is assigned to a client'; end if;
  delete from public.outreach_integrations where id=p_id;
  delete from vault.secrets where id=old.secret_id;
  insert into public.outreach_integration_audit(actor_id,integration_id,event) values(p_actor,p_id,'removed');
end; $$;

-- Serialize assignment against rotation/removal, including privileged inserts.
create function outreach_private.guard_managed_integration_binding() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if new.credential_ref ~ '^OUTREACH_(INSTANTLY|HEYREACH)_VAULT_' then
    perform 1 from public.outreach_integrations where credential_ref=new.credential_ref and remote_workspace_id=new.remote_workspace_id::text for share;
    if not found then raise invalid_parameter_value; end if;
  end if;
  return new;
end; $$;
revoke all on function outreach_private.guard_managed_integration_binding() from public,anon,authenticated,service_role;
create trigger managed_account_integration before insert or update on public.outreach_account_workspaces
  for each row execute function outreach_private.guard_managed_integration_binding();
create trigger managed_reply_integration before insert or update on public.outreach_reply_workspaces
  for each row execute function outreach_private.guard_managed_integration_binding();

create function outreach_private.guard_integration_connection_start() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare ref text;
begin
  if new.channel='email' then select credential_ref into ref from public.outreach_account_workspaces where client_id=new.client_id;
  else select credential_ref into ref from public.outreach_reply_workspaces where client_id=new.client_id and channel='linkedin'; end if;
  if ref ~ '^OUTREACH_(INSTANTLY|HEYREACH)_VAULT_' then
    perform 1 from public.outreach_integrations where credential_ref=ref for share;
    if not found then raise invalid_parameter_value; end if;
  end if;
  return new;
end; $$;
revoke all on function outreach_private.guard_integration_connection_start() from public,anon,authenticated,service_role;
create trigger managed_integration_connection_start before insert on public.outreach_connections
  for each row execute function outreach_private.guard_integration_connection_start();

revoke all on function public.save_outreach_integration(uuid,bigint,uuid,bigint,text,text,text,text),
  public.read_outreach_integration_key(text),public.check_outreach_integration(uuid,bigint,uuid,bigint,boolean),
  public.remove_outreach_integration(uuid,bigint,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.save_outreach_integration(uuid,bigint,uuid,bigint,text,text,text,text),
  public.read_outreach_integration_key(text),public.check_outreach_integration(uuid,bigint,uuid,bigint,boolean),
  public.remove_outreach_integration(uuid,bigint,uuid,bigint) to service_role;
notify pgrst,'reload schema';
