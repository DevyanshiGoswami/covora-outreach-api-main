-- Owner login delegated to the Covora workspace. Tokens are opaque and hashed;
-- the verified upstream bearer is encrypted in Vault and never returned locally.
create table public.outreach_developer_sessions (
 token_hash text primary key check(token_hash ~ '^[a-f0-9]{64}$'),
 user_id uuid not null references auth.users(id) on delete cascade,
 client_id uuid not null references public.clients(id) on delete cascade,
 owner_version bigint not null,
 secret_id uuid not null unique references vault.secrets(id),
 created_at timestamptz not null default now(),
 expires_at timestamptz not null
);
create index on public.outreach_developer_sessions(user_id,created_at);
alter table public.outreach_developer_sessions enable row level security;
revoke all on public.outreach_developer_sessions from public,anon,authenticated,service_role;
-- Access only through the narrowly granted functions below.
create function outreach_private.delete_developer_secret() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin delete from vault.secrets where id=old.secret_id; return old; end; $$;
revoke all on function outreach_private.delete_developer_secret() from public,anon,authenticated,service_role;
create trigger delete_developer_secret after delete on public.outreach_developer_sessions
 for each row execute function outreach_private.delete_developer_secret();

create function public.issue_outreach_developer_session(p_user uuid,p_client uuid,p_hash text,p_bearer text,p_expires timestamptz) returns timestamptz
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare owner_version bigint; secret uuid; expiry timestamptz;
begin
 select version into owner_version from public.outreach_agency_memberships where user_id=p_user and state='active' for update;
 if not found or not exists(select 1 from auth.users where id=p_user and deleted_at is null and (banned_until is null or banned_until<=now()))
   or not exists(select 1 from public.clients where id=p_client and slug='covora') then raise insufficient_privilege; end if;
 if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' or p_bearer is null or length(p_bearer) not between 20 and 16384
   or p_expires is null or p_expires<=now() then raise invalid_parameter_value; end if;
 delete from public.outreach_developer_sessions where expires_at<=now();
 if (select count(*) from public.outreach_developer_sessions where user_id=p_user)>=10 then raise insufficient_privilege; end if;
 expiry:=least(p_expires,now()+interval '1 hour');
 secret:=vault.create_secret(p_bearer);
 insert into public.outreach_developer_sessions(token_hash,user_id,client_id,owner_version,secret_id,expires_at)
 values(p_hash,p_user,p_client,owner_version,secret,expiry);
 return expiry;
end; $$;

create function public.read_outreach_developer_session(p_hash text,p_client uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select jsonb_build_object('userId',s.user_id,'email',u.email,'clientId',c.id,'clientName',c.name,
   'expiresAt',s.expires_at,'bearer',v.decrypted_secret)
 from public.outreach_developer_sessions s join auth.users u on u.id=s.user_id
 join public.clients c on c.id=s.client_id
 join public.outreach_agency_memberships m on m.user_id=s.user_id
 join vault.decrypted_secrets v on v.id=s.secret_id
 where s.token_hash=p_hash and s.client_id=p_client and c.slug='covora' and s.expires_at>now()
 and m.state='active' and m.version=s.owner_version and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now());
$$;
create function public.revoke_outreach_developer_session(p_hash text) returns void
language sql security definer set search_path=pg_catalog,public,pg_temp as $$
 delete from public.outreach_developer_sessions where token_hash=p_hash;
$$;
revoke all on function public.issue_outreach_developer_session(uuid,uuid,text,text,timestamptz),public.read_outreach_developer_session(text,uuid),public.revoke_outreach_developer_session(text) from public,anon,authenticated;
grant execute on function public.issue_outreach_developer_session(uuid,uuid,text,text,timestamptz),public.read_outreach_developer_session(text,uuid),public.revoke_outreach_developer_session(text) to service_role;
notify pgrst,'reload schema';
