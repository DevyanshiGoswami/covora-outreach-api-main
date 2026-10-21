-- Real client collaboration is independent of preview outreach and provider gates.
-- Default off; an explicit service-side EPM rollout enables this one workspace.
create table public.outreach_comment_settings (
  client_id uuid primary key references public.clients(id) on delete cascade
    check (client_id = '26a2cffb-47f4-4231-9195-b4f772751c6d'::uuid),
  enabled boolean not null default false
);
create table public.outreach_comment_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 120),
  body text not null check (length(btrim(body)) between 1 and 5000),
  author_user_id uuid references auth.users(id) on delete set null,
  author_name text not null check (length(author_name) between 1 and 200),
  status text not null default 'open' check (status in ('open','in_progress','resolved')),
  version bigint not null default 1 check (version > 0),
  reply_count integer not null default 0 check (reply_count >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid references auth.users(id) on delete set null,
  unique (id, client_id)
);
create index outreach_comment_request_created on public.outreach_comment_requests(client_id,created_at desc,id);
create table public.outreach_comment_messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  client_id uuid not null references public.clients(id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 5000),
  author_user_id uuid references auth.users(id) on delete set null,
  author_name text not null check (length(author_name) between 1 and 200),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (request_id,client_id) references public.outreach_comment_requests(id,client_id) on delete cascade
);
create index outreach_comment_message_page on public.outreach_comment_messages(client_id,request_id,created_at,id);
create table public.outreach_comment_commands (
  client_id uuid not null references public.clients(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  command_id uuid not null,
  kind text not null check (kind in ('create','reply')),
  request_id uuid not null,
  payload_hash text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (client_id,actor_user_id,command_id),
  foreign key (request_id,client_id) references public.outreach_comment_requests(id,client_id) on delete cascade
);

alter table public.outreach_comment_settings enable row level security;
alter table public.outreach_comment_requests enable row level security;
alter table public.outreach_comment_messages enable row level security;
alter table public.outreach_comment_commands enable row level security;
create policy comment_settings_service on public.outreach_comment_settings for all to service_role using(true) with check(true);
create policy comment_requests_service on public.outreach_comment_requests for all to service_role using(true) with check(true);
create policy comment_messages_service on public.outreach_comment_messages for all to service_role using(true) with check(true);
create policy comment_commands_service on public.outreach_comment_commands for all to service_role using(true) with check(true);
revoke all on public.outreach_comment_settings,public.outreach_comment_requests,public.outreach_comment_messages,public.outreach_comment_commands from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.outreach_comment_settings,public.outreach_comment_requests,public.outreach_comment_messages,public.outreach_comment_commands to service_role;

-- Use the existing workspace/authority lock order so suspension, feature changes,
-- and command replay never bypass present authorization. No supplied actor ID.
create function outreach_private.comment_access(p_client uuid,p_write boolean default false,p_manage boolean default false,p_require_enabled boolean default true)
returns text language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare actor_role text; is_enabled boolean;
begin
  perform outreach_private.lock_team_workspace(p_client);
  actor_role:=outreach_private.lock_team_role(p_client,auth.uid());
  if auth.uid() is null or actor_role is null then
    raise exception using errcode='42501',message='Comments unavailable';
  end if;
  select s.enabled into is_enabled from public.outreach_comment_settings s where s.client_id=p_client for share;
  if p_require_enabled and (p_client<>'26a2cffb-47f4-4231-9195-b4f772751c6d'::uuid or not coalesce(is_enabled,false))
    or p_write and actor_role not in ('client_admin','client_member','operator','agency_owner')
    or p_manage and actor_role not in ('operator','agency_owner') then
    raise exception using errcode='42501',message='Comments unavailable';
  end if;
  return actor_role;
end;
$$;
revoke all on function outreach_private.comment_access(uuid,boolean,boolean,boolean) from public,anon,authenticated,service_role;

create function outreach_private.comment_author() returns text
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select coalesce(nullif(btrim((select p.full_name from public.profiles p where p.id=auth.uid())),''),'Workspace member');
$$;
revoke all on function outreach_private.comment_author() from public,anon,authenticated,service_role;

create function outreach_private.comment_summary(r public.outreach_comment_requests) returns jsonb
language sql immutable set search_path=pg_catalog,public,pg_temp as $$
  select jsonb_build_object('id',r.id,'clientId',r.client_id,'title',r.title,'status',r.status,'version',r.version,
    'createdAt',r.created_at,'updatedAt',r.updated_at,'authorName',r.author_name,'replyCount',r.reply_count);
$$;
revoke all on function outreach_private.comment_summary(public.outreach_comment_requests) from public,anon,authenticated,service_role;

-- Match JavaScript String.length and trim exactly, including astral characters,
-- NBSP and BOM. Direct authenticated RPC writes must remain readable by the API.
create function outreach_private.comment_text(p_value text,p_limit integer) returns text
language plpgsql immutable set search_path=pg_catalog,public,pg_temp as $$
declare normalized text; units bigint;
begin
  if p_value is null then raise exception using errcode='22023',message='Invalid comment'; end if;
  select coalesce(sum(case when ascii(ch)>65535 then 2 else 1 end),0) into units
    from regexp_split_to_table(p_value,'') ch;
  normalized:=btrim(p_value,chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
    chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||
    chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279));
  if units>p_limit or normalized='' then raise exception using errcode='22023',message='Invalid comment'; end if;
  return normalized;
end;
$$;
revoke all on function outreach_private.comment_text(text,integer) from public,anon,authenticated,service_role;

create function public.list_outreach_comments(p_client uuid,p_status text default 'all',p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare actor_role text; is_enabled boolean; rows jsonb;
begin
  actor_role:=outreach_private.comment_access(p_client,false,false,false);
  if p_offset is null or p_offset<0 or p_offset>100000 or p_status is null or p_status not in ('all','open','in_progress','resolved') then
    raise exception using errcode='22023',message='Invalid comments query';
  end if;
  select coalesce((select enabled from public.outreach_comment_settings where client_id=p_client),false) into is_enabled;
  if not is_enabled then
    return jsonb_build_object('clientId',p_client,'enabled',false,'permissions',jsonb_build_object('canComment',false,'canManage',false),'requests','[]'::jsonb,'hasMore',false);
  end if;
  select coalesce(jsonb_agg(outreach_private.comment_summary(r) order by r.created_at desc,r.id),'[]'::jsonb) into rows
    from (select * from public.outreach_comment_requests where client_id=p_client and (p_status='all' or status=p_status)
      order by created_at desc,id limit 26 offset p_offset) r;
  return jsonb_build_object('clientId',p_client,'enabled',true,
    'permissions',jsonb_build_object('canComment',actor_role<>'client_viewer','canManage',actor_role in ('operator','agency_owner')),
    'requests',case when jsonb_array_length(rows)>25 then rows-25 else rows end,'hasMore',jsonb_array_length(rows)>25);
end;
$$;

create function public.get_outreach_comment(p_client uuid,p_request uuid,p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare item public.outreach_comment_requests%rowtype; rows jsonb;
begin
  perform outreach_private.comment_access(p_client);
  if p_offset is null or p_offset<0 or p_offset>100000 then raise exception using errcode='22023',message='Invalid comments query'; end if;
  select * into item from public.outreach_comment_requests where client_id=p_client and id=p_request;
  if not found then raise exception using errcode='42501',message='Comments unavailable'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'requestId',m.request_id,'clientId',m.client_id,'body',m.body,
    'authorName',m.author_name,'createdAt',m.created_at) order by m.created_at,m.id),'[]'::jsonb) into rows
    from (select * from public.outreach_comment_messages where client_id=p_client and request_id=p_request
      order by created_at,id limit 26 offset p_offset) m;
  return jsonb_build_object('clientId',p_client,'request',outreach_private.comment_summary(item)||jsonb_build_object('body',item.body),
    'messages',case when jsonb_array_length(rows)>25 then rows-25 else rows end,'hasMore',jsonb_array_length(rows)>25);
end;
$$;

create function public.create_outreach_comment(p_client uuid,p_command uuid,p_title text,p_body text)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare prior public.outreach_comment_commands%rowtype; fingerprint text; result uuid;
begin
  perform outreach_private.comment_access(p_client,true);
  if p_command is null then raise exception using errcode='22023',message='Invalid comment'; end if;
  p_title:=outreach_private.comment_text(p_title,120);
  p_body:=outreach_private.comment_text(p_body,5000);
  fingerprint:=encode(extensions.digest(jsonb_build_array(p_title,p_body)::text,'sha256'),'hex');
  select * into prior from public.outreach_comment_commands where client_id=p_client and actor_user_id=auth.uid() and command_id=p_command;
  if found then
    if prior.kind<>'create' or prior.payload_hash<>fingerprint then raise exception using errcode='40001',message='Comment command conflict'; end if;
    return prior.request_id;
  end if;
  insert into public.outreach_comment_requests(client_id,title,body,author_user_id,author_name,updated_by)
    values(p_client,btrim(p_title),btrim(p_body),auth.uid(),outreach_private.comment_author(),auth.uid()) returning id into result;
  insert into public.outreach_comment_commands(client_id,actor_user_id,command_id,kind,request_id,payload_hash)
    values(p_client,auth.uid(),p_command,'create',result,fingerprint);
  return result;
end;
$$;

create function public.reply_outreach_comment(p_client uuid,p_request uuid,p_command uuid,p_body text)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare prior public.outreach_comment_commands%rowtype; fingerprint text;
begin
  perform outreach_private.comment_access(p_client,true);
  if p_command is null then raise exception using errcode='22023',message='Invalid comment'; end if;
  p_body:=outreach_private.comment_text(p_body,5000);
  perform 1 from public.outreach_comment_requests where id=p_request and client_id=p_client for update;
  if not found then raise exception using errcode='42501',message='Comments unavailable'; end if;
  fingerprint:=encode(extensions.digest(jsonb_build_array(p_request,p_body)::text,'sha256'),'hex');
  select * into prior from public.outreach_comment_commands where client_id=p_client and actor_user_id=auth.uid() and command_id=p_command;
  if found then
    if prior.kind<>'reply' or prior.payload_hash<>fingerprint then raise exception using errcode='40001',message='Comment command conflict'; end if;
    return prior.request_id;
  end if;
  insert into public.outreach_comment_messages(client_id,request_id,body,author_user_id,author_name)
    values(p_client,p_request,btrim(p_body),auth.uid(),outreach_private.comment_author());
  update public.outreach_comment_requests set reply_count=reply_count+1,version=version+1,updated_at=clock_timestamp(),updated_by=auth.uid()
    where id=p_request and client_id=p_client;
  insert into public.outreach_comment_commands(client_id,actor_user_id,command_id,kind,request_id,payload_hash)
    values(p_client,auth.uid(),p_command,'reply',p_request,fingerprint);
  return p_request;
end;
$$;

create function public.set_outreach_comment_status(p_client uuid,p_request uuid,p_version bigint,p_status text)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare item public.outreach_comment_requests%rowtype;
begin
  perform outreach_private.comment_access(p_client,true,true);
  if p_version is null or p_version<1 or p_status is null or p_status not in ('open','in_progress','resolved') then
    raise exception using errcode='22023',message='Invalid comment status'; end if;
  select * into item from public.outreach_comment_requests where id=p_request and client_id=p_client for update;
  if not found then raise exception using errcode='42501',message='Comments unavailable'; end if;
  if item.version<>p_version then raise exception using errcode='40001',message='Comment changed; refresh before updating'; end if;
  update public.outreach_comment_requests set status=p_status,version=version+1,updated_at=clock_timestamp(),updated_by=auth.uid()
    where id=p_request and client_id=p_client;
end;
$$;

revoke all on function public.list_outreach_comments(uuid,text,integer),public.get_outreach_comment(uuid,uuid,integer),
  public.create_outreach_comment(uuid,uuid,text,text),public.reply_outreach_comment(uuid,uuid,uuid,text),
  public.set_outreach_comment_status(uuid,uuid,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.list_outreach_comments(uuid,text,integer),public.get_outreach_comment(uuid,uuid,integer),
  public.create_outreach_comment(uuid,uuid,text,text),public.reply_outreach_comment(uuid,uuid,uuid,text),
  public.set_outreach_comment_status(uuid,uuid,bigint,text) to authenticated;
