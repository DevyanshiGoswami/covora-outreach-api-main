-- Client-owned CRM authorization only. No lead reads or writes at the provider.
create table public.outreach_crm_connections (
 client_id uuid primary key references public.clients(id) on delete cascade,
 secret_id uuid unique references vault.secrets(id),
 workspaces jsonb not null default '[]'::jsonb,
 connected_by uuid, connected_at timestamptz,
 version bigint not null default 0
);
create table public.outreach_crm_authorizations (
 id uuid primary key default gen_random_uuid(),
 client_id uuid not null references public.clients(id) on delete cascade,
 actor_id uuid not null references auth.users(id) on delete cascade,
 actor_stamp text not null, connection_version bigint not null,
 state_hash text unique not null check(state_hash ~ '^[a-f0-9]{64}$'),
 browser_hash text not null check(browser_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz not null default now()+interval '10 minutes',
 consumed_at timestamptz, completed_at timestamptz
);
alter table public.outreach_crm_connections enable row level security;
alter table public.outreach_crm_authorizations enable row level security;
revoke all on public.outreach_crm_connections,public.outreach_crm_authorizations from public,anon,authenticated,service_role;

create function outreach_private.crm_manager_stamp(p_client uuid,p_actor uuid) returns text
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v bigint;
begin
 perform 1 from public.client_features where client_id=p_client and feature='outreach_app' and enabled for share;
 if not found then raise insufficient_privilege; end if;
 select version into v from public.outreach_agency_memberships where user_id=p_actor and state='active' for share;
 if found then return 'owner:'||v; end if;
 select version into v from public.outreach_memberships where client_id=p_client and user_id=p_actor and state='active' and role='client_admin' for share;
 if found then return 'admin:'||v; end if;
 raise insufficient_privilege;
end; $$;
revoke all on function outreach_private.crm_manager_stamp(uuid,uuid) from public,anon,authenticated,service_role;

create function public.outreach_crm_status(p_client_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r text; c public.outreach_crm_connections%rowtype;
begin
 r:=outreach_private.workspace_role(p_client_id);
 if r is null then raise insufficient_privilege; end if;
 select * into c from public.outreach_crm_connections where client_id=p_client_id;
 return jsonb_build_object('canManage',r in ('agency_owner','client_admin'),'connected',c.secret_id is not null,
 'connectedAt',c.connected_at,'version',coalesce(c.version,0),
 'workspaces',coalesce((select jsonb_agg(jsonb_build_object('name',w->>'name')) from jsonb_array_elements(c.workspaces) w),'[]'::jsonb));
end; $$;

create function public.begin_outreach_crm_authorization(p_client_id uuid,p_state_hash text,p_browser_hash text) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare stamp text; v bigint;
begin
 stamp:=outreach_private.crm_manager_stamp(p_client_id,auth.uid());
 perform pg_advisory_xact_lock(hashtextextended('crm:'||p_client_id,0));
 insert into public.outreach_crm_connections(client_id) values(p_client_id) on conflict do nothing;
 select version into v from public.outreach_crm_connections where client_id=p_client_id for update;
 delete from public.outreach_crm_authorizations where client_id=p_client_id and (actor_id=auth.uid() or expires_at<now());
 insert into public.outreach_crm_authorizations(client_id,actor_id,actor_stamp,connection_version,state_hash,browser_hash)
 values(p_client_id,auth.uid(),stamp,v,p_state_hash,p_browser_hash);
end; $$;

create function public.consume_outreach_crm_authorization(p_client_id uuid,p_state_hash text,p_browser_hash text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare a public.outreach_crm_authorizations%rowtype; stamp text;
begin
 stamp:=outreach_private.crm_manager_stamp(p_client_id,auth.uid());
 perform pg_advisory_xact_lock(hashtextextended('crm:'||p_client_id,0));
 select * into a from public.outreach_crm_authorizations where client_id=p_client_id and actor_id=auth.uid() and state_hash=p_state_hash and browser_hash=p_browser_hash for update;
 if not found or a.consumed_at is not null or a.expires_at<=now() or a.actor_stamp<>stamp
 or a.connection_version<>(select version from public.outreach_crm_connections where client_id=p_client_id) then raise insufficient_privilege; end if;
 update public.outreach_crm_authorizations set consumed_at=now() where id=a.id;
 return a.id;
end; $$;

create function public.complete_outreach_crm_authorization(p_attempt_id uuid,p_token text,p_workspaces jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare a public.outreach_crm_authorizations%rowtype; c public.outreach_crm_connections%rowtype; secret uuid; stamp text;
begin
 select * into a from public.outreach_crm_authorizations where id=p_attempt_id;
 if not found then raise insufficient_privilege; end if;
 stamp:=outreach_private.crm_manager_stamp(a.client_id,a.actor_id);
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

create function public.disconnect_outreach_crm(p_client_id uuid,p_version bigint) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_crm_connections%rowtype;
begin
 perform outreach_private.crm_manager_stamp(p_client_id,auth.uid());
 perform pg_advisory_xact_lock(hashtextextended('crm:'||p_client_id,0));
 select * into c from public.outreach_crm_connections where client_id=p_client_id for update;
 if not found or c.version<>p_version then raise invalid_parameter_value; end if;
 update public.outreach_crm_connections set secret_id=null,workspaces='[]',connected_by=null,connected_at=null,version=version+1 where client_id=p_client_id;
 delete from public.outreach_crm_authorizations where client_id=p_client_id;
 if c.secret_id is not null then delete from vault.secrets where id=c.secret_id; end if;
end; $$;

revoke all on function public.outreach_crm_status(uuid),public.begin_outreach_crm_authorization(uuid,text,text),public.consume_outreach_crm_authorization(uuid,text,text),public.disconnect_outreach_crm(uuid,bigint),public.complete_outreach_crm_authorization(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.outreach_crm_status(uuid),public.begin_outreach_crm_authorization(uuid,text,text),public.consume_outreach_crm_authorization(uuid,text,text),public.disconnect_outreach_crm(uuid,bigint) to authenticated;
grant execute on function public.complete_outreach_crm_authorization(uuid,text,jsonb) to service_role;

-- Deleting a client must also remove its encrypted authorization.
create function outreach_private.cleanup_crm_secret() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 if old.secret_id is not null then delete from vault.secrets where id=old.secret_id; end if;
 return old;
end; $$;
revoke all on function outreach_private.cleanup_crm_secret() from public,anon,authenticated,service_role;
create trigger cleanup_crm_secret after delete on public.outreach_crm_connections
 for each row execute function outreach_private.cleanup_crm_secret();
