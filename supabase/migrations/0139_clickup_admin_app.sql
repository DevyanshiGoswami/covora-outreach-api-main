-- Agency-wide OAuth application settings; client grants remain separate.
create table public.outreach_clickup_app (
 singleton boolean primary key default true check(singleton),
 client_id text, redirect_uri text, secret_id uuid unique references vault.secrets(id),
 version bigint not null default 0 check(version>=0), updated_at timestamptz,
 updated_by uuid
);
insert into public.outreach_clickup_app(singleton) values(true);
alter table public.outreach_clickup_app enable row level security;
revoke all on public.outreach_clickup_app from public,anon,authenticated,service_role;
grant select on public.outreach_clickup_app to service_role;
create policy clickup_app_service_read on public.outreach_clickup_app for select to service_role using(true);

create function public.read_outreach_clickup_app() returns jsonb
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select jsonb_build_object('version',a.version,'clientId',a.client_id,'clientSecret',s.decrypted_secret,'redirectUri',a.redirect_uri)
 from public.outreach_clickup_app a left join vault.decrypted_secrets s on s.id=a.secret_id where a.singleton;
$$;

create function public.save_outreach_clickup_app(p_actor uuid,p_actor_version bigint,p_version bigint,p_client_id text,p_secret text,p_redirect_uri text) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare old public.outreach_clickup_app%rowtype; secret uuid;
begin
 perform outreach_private.lock_integration_owner(p_actor,p_actor_version);
 select * into old from public.outreach_clickup_app where singleton for update;
 if p_version is null or old.version<>p_version then raise invalid_parameter_value; end if;
 if p_client_id is null or length(p_client_id) not between 1 and 200 or p_client_id ~ '[[:space:]]'
 or p_secret is null or length(p_secret) not between 8 and 4096 or p_secret ~ '[[:space:]]'
 or p_redirect_uri is null or length(p_redirect_uri)>2048
 or p_redirect_uri !~ '^(https://[^/?#@]+|http://127\.0\.0\.1(:[0-9]+)?)/auth/clickup/callback$' then raise invalid_parameter_value; end if;
 -- A different app cannot inherit grants issued to the old app.
 if old.client_id is distinct from p_client_id and exists(select 1 from public.outreach_crm_connections where secret_id is not null) then
  raise exception using errcode='22023',message='Disconnect client grants before replacing the app';
 end if;
 secret:=vault.create_secret(p_secret);
 update public.outreach_clickup_app set client_id=p_client_id,redirect_uri=p_redirect_uri,secret_id=secret,version=version+1,updated_at=now(),updated_by=p_actor where singleton;
 if old.secret_id is not null then delete from vault.secrets where id=old.secret_id; end if;
end; $$;

create function public.disable_outreach_clickup_app(p_actor uuid,p_actor_version bigint,p_version bigint) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare old public.outreach_clickup_app%rowtype;
begin
 perform outreach_private.lock_integration_owner(p_actor,p_actor_version);
 select * into old from public.outreach_clickup_app where singleton for update;
 if p_version is null or old.version<>p_version then raise invalid_parameter_value; end if;
 update public.outreach_clickup_app set secret_id=null,version=version+1,updated_at=now(),updated_by=p_actor where singleton;
 if old.secret_id is not null then delete from vault.secrets where id=old.secret_id; end if;
end; $$;
revoke all on function public.read_outreach_clickup_app(),public.save_outreach_clickup_app(uuid,bigint,bigint,text,text,text),public.disable_outreach_clickup_app(uuid,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.read_outreach_clickup_app(),public.save_outreach_clickup_app(uuid,bigint,bigint,text,text,text),public.disable_outreach_clickup_app(uuid,bigint,bigint) to service_role;

-- Bind every authorization to the exact app settings it started with.
alter table public.outreach_crm_authorizations add column app_version bigint not null default 0;
drop function public.begin_outreach_crm_authorization(uuid,text,text);
drop function public.consume_outreach_crm_authorization(uuid,text,text);
create function public.begin_outreach_crm_authorization(p_client_id uuid,p_state_hash text,p_browser_hash text,p_app_version bigint default 0) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare stamp text; v bigint;
begin
 stamp:=outreach_private.crm_manager_stamp(p_client_id,auth.uid());
 perform 1 from public.outreach_clickup_app where singleton and version=p_app_version for share;
 if not found then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('crm:'||p_client_id,0));
 insert into public.outreach_crm_connections(client_id) values(p_client_id) on conflict do nothing;
 select version into v from public.outreach_crm_connections where client_id=p_client_id for update;
 delete from public.outreach_crm_authorizations where client_id=p_client_id and (actor_id=auth.uid() or expires_at<now());
 insert into public.outreach_crm_authorizations(client_id,actor_id,actor_stamp,connection_version,state_hash,browser_hash,app_version)
 values(p_client_id,auth.uid(),stamp,v,p_state_hash,p_browser_hash,p_app_version);
end; $$;

create function public.consume_outreach_crm_authorization(p_client_id uuid,p_state_hash text,p_browser_hash text,p_app_version bigint default 0) returns uuid
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare a public.outreach_crm_authorizations%rowtype; stamp text;
begin
 stamp:=outreach_private.crm_manager_stamp(p_client_id,auth.uid());
 perform 1 from public.outreach_clickup_app where singleton and version=p_app_version for share;
 if not found then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('crm:'||p_client_id,0));
 select * into a from public.outreach_crm_authorizations where client_id=p_client_id and actor_id=auth.uid() and state_hash=p_state_hash and browser_hash=p_browser_hash for update;
 if not found or a.app_version<>p_app_version or a.consumed_at is not null or a.expires_at<=now() or a.actor_stamp<>stamp
 or a.connection_version<>(select version from public.outreach_crm_connections where client_id=p_client_id) then raise insufficient_privilege; end if;
 update public.outreach_crm_authorizations set consumed_at=now() where id=a.id;
 return a.id;
end; $$;

create or replace function public.complete_outreach_crm_authorization(p_attempt_id uuid,p_token text,p_workspaces jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare a public.outreach_crm_authorizations%rowtype; c public.outreach_crm_connections%rowtype; secret uuid; stamp text;
begin
 select * into a from public.outreach_crm_authorizations where id=p_attempt_id;
 if not found then raise insufficient_privilege; end if;
 stamp:=outreach_private.crm_manager_stamp(a.client_id,a.actor_id);
 perform 1 from public.outreach_clickup_app where singleton and version=a.app_version for share;
 if not found then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('crm:'||a.client_id,0));
 select * into a from public.outreach_crm_authorizations where id=p_attempt_id for update;
 if not found or a.consumed_at is null or a.completed_at is not null or a.expires_at<=now() or a.actor_stamp<>stamp then raise insufficient_privilege; end if;
 select * into c from public.outreach_crm_connections where client_id=a.client_id for update;
 if c.version<>a.connection_version then raise insufficient_privilege; end if;
 if p_token is null or length(p_token) not between 8 and 8192 or p_workspaces is null or jsonb_typeof(p_workspaces)<>'array' or jsonb_array_length(p_workspaces) not between 1 and 100 then raise invalid_parameter_value; end if;
 select vault.create_secret(p_token) into secret;
 update public.outreach_crm_connections set secret_id=secret,workspaces=p_workspaces,connected_by=a.actor_id,connected_at=now(),version=version+1 where client_id=a.client_id;
 if c.secret_id is not null then delete from vault.secrets where id=c.secret_id; end if;
 update public.outreach_crm_authorizations set completed_at=now() where id=a.id;
end; $$;

revoke all on function public.begin_outreach_crm_authorization(uuid,text,text,bigint),public.consume_outreach_crm_authorization(uuid,text,text,bigint) from public,anon,authenticated,service_role;
grant execute on function public.begin_outreach_crm_authorization(uuid,text,text,bigint),public.consume_outreach_crm_authorization(uuid,text,text,bigint) to authenticated;
notify pgrst,'reload schema';
