-- Expired login attempts cannot keep an owner from rotating a verified key.
-- Completion already rejects expired attempts independently.
create or replace function public.save_outreach_integration(p_actor uuid,p_actor_version bigint,p_id uuid,p_version bigint,p_channel text,p_label text,p_workspace text,p_key text) returns void
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
    if exists(select 1 from public.outreach_connections c where c.state in ('starting','pending') and c.expires_at>clock_timestamp() and (
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

notify pgrst,'reload schema';
