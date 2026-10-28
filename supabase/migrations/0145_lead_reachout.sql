-- Explicit, one-recipient outreach. Connection alone never enables sending.
create table public.outreach_compose_settings (
  client_id uuid not null references public.clients(id) on delete cascade,
  channel text not null check(channel in ('email','linkedin')),
  enabled boolean not null default false,
  primary key(client_id,channel)
);
create table public.outreach_compose_commands (
  id uuid primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  lead_id uuid not null,
  sender_id uuid not null,
  channel text not null check(channel in ('email','linkedin')),
  actor_id uuid not null references auth.users(id),
  actor_role text not null,
  sender_version bigint not null,
  workspace_version bigint not null,
  recipient text not null,
  recipient_name text not null,
  sender_name text not null,
  sender_address text not null,
  subject text not null default '' check(length(subject)<=200),
  body_text text not null check(length(body_text)<=4000),
  status text not null default 'preparing' check(status in ('preparing','queued','sent','connected','replied','failed','unknown')),
  claim_token uuid,
  remote_campaign_id text,
  remote_list_id text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  checked_at timestamptz,
  foreign key(sender_id,client_id,channel) references public.outreach_reply_senders(id,client_id,channel)
);
create unique index outreach_compose_recipient_once on public.outreach_compose_commands(sender_id,lower(recipient)) where status<>'failed';
create index outreach_compose_history on public.outreach_compose_commands(client_id,created_at desc);
alter table public.outreach_compose_settings enable row level security;
alter table public.outreach_compose_commands enable row level security;
revoke all on public.outreach_compose_settings,public.outreach_compose_commands from public,anon,authenticated;
grant select,insert,update,delete on public.outreach_compose_settings,public.outreach_compose_commands to service_role;

create function outreach_private.compose_access(p_client uuid,p_actor uuid,p_write boolean) returns text
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r text;
begin
 perform outreach_private.lock_team_workspace(p_client);
 r:=outreach_private.lock_team_role(p_client,p_actor);
 if r is null or (p_write and r not in ('agency_owner','operator','client_admin','client_member'))
   or exists(select 1 from public.client_features where client_id=p_client and feature='outreach_app' and config->>'presentation_mode'='preview')
 then raise exception using errcode='42501',message='Outreach unavailable'; end if;
 return r;
end; $$;

create function outreach_private.compose_lead(p_client uuid,p_lead uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v jsonb;
begin
 select jsonb_build_object('id',id,'name',btrim(first_name||' '||last_name),'email',email,'profile',linkedin_url)
 into v from public.outreach_imported_leads where id=p_lead and client_id=p_client and review_state='client';
 if v is null then
   select jsonb_build_object('id',id,'name',btrim(coalesce(first_name,'')||' '||coalesce(last_name,'')),'email',email,'profile',linkedin_url)
   into v from public.outreach_leads where id=p_lead and client_id=p_client and status not in ('unsubscribed','bounced','skipped');
 end if;
 if v is null then raise exception using errcode='42501',message='Lead unavailable'; end if;
 v:=jsonb_set(v,'{email}',coalesce(to_jsonb(lower(btrim(v->>'email'))),'null'::jsonb));
 v:=jsonb_set(v,'{profile}',case when v->>'profile' ~ '^https://(www\.)?linkedin\.com/in/[A-Za-z0-9_-]{1,200}/?$'
   then to_jsonb('https://www.linkedin.com/in/'||regexp_replace(v->>'profile','^https://(www\.)?linkedin\.com/in/|/$','','g')) else 'null'::jsonb end);
 return v;
end; $$;

create function outreach_private.compose_projection(c public.outreach_compose_commands) returns jsonb
language sql stable set search_path=pg_catalog,public,pg_temp as $$
 select jsonb_build_object('id',c.id,'clientId',c.client_id,'leadId',c.lead_id,'senderId',c.sender_id,'channel',c.channel,
 'recipient',c.recipient,'recipientName',c.recipient_name,'senderName',c.sender_name,'senderAddress',c.sender_address,
 'subject',c.subject,'body',c.body_text,'status',c.status,'createdAt',c.created_at,'updatedAt',c.updated_at,'checkedAt',c.checked_at);
$$;

create function public.get_outreach_compose(p_client uuid,p_lead uuid default null,p_channel text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r text; l jsonb;
begin
 r:=outreach_private.compose_access(p_client,auth.uid(),false);
 if p_channel is not null and p_channel not in ('email','linkedin') then raise exception using errcode='22023',message='Invalid channel'; end if;
 if p_lead is not null then l:=outreach_private.compose_lead(p_client,p_lead); end if;
 return jsonb_build_object('clientId',p_client,'lead',l,'canWrite',r<>'client_viewer',
 'senders',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'channel',s.channel,'name',s.sender_label,'address',s.sender_address,
 'enabled',s.enabled and w.enabled and coalesce(cfg.enabled,false))) from public.outreach_reply_senders s
 join public.outreach_reply_workspaces w on w.id=s.workspace_id and w.client_id=s.client_id
 left join public.outreach_compose_settings cfg on cfg.client_id=s.client_id and cfg.channel=s.channel
 where s.client_id=p_client and (p_channel is null or s.channel=p_channel)),'[]'::jsonb),
 'history',coalesce((select jsonb_agg(outreach_private.compose_projection(c) order by c.created_at desc) from
 (select * from public.outreach_compose_commands where client_id=p_client and (p_lead is null or lead_id=p_lead)
 and (p_channel is null or channel=p_channel) order by created_at desc limit 100) c),'[]'::jsonb));
end; $$;

create function public.prepare_outreach_compose(p_client uuid,p_lead uuid,p_sender uuid,p_command uuid,p_recipient text,p_subject text,p_body text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r text; l jsonb; s public.outreach_reply_senders%rowtype; w public.outreach_reply_workspaces%rowtype;
 c public.outreach_compose_commands%rowtype; destination text;
begin
 r:=outreach_private.compose_access(p_client,auth.uid(),true);
 l:=outreach_private.compose_lead(p_client,p_lead);
 select * into s from public.outreach_reply_senders where id=p_sender and client_id=p_client for share;
 if not found then raise exception using errcode='42501',message='Sender unavailable'; end if;
 select * into w from public.outreach_reply_workspaces where id=s.workspace_id and client_id=p_client for share;
 destination:=case when s.channel='linkedin' then l->>'profile' else lower(l->>'email') end;
 if exists(select 1 from public.outreach_leads where client_id=p_client and status in ('unsubscribed','bounced')
   and (s.channel='email' and lower(email)=lower(destination) or s.channel='linkedin' and rtrim(regexp_replace(lower(linkedin_url),'^https://(www\.)?',''),'/')=rtrim(regexp_replace(lower(destination),'^https://(www\.)?',''),'/')))
   or exists(select 1 from public.outreach_conversations where client_id=p_client and channel=s.channel and suppressed and rtrim(regexp_replace(lower(contact_address),'^https://(www\.)?',''),'/')=rtrim(regexp_replace(lower(destination),'^https://(www\.)?',''),'/'))
 then raise exception using errcode='42501',message='Recipient is suppressed'; end if;
 if destination is null or destination<>p_recipient or p_subject is null or p_body is null
 or length(p_subject)>200 or length(p_body)>4000 or (s.channel='linkedin' and (length(p_body)>200 or p_subject<>''))
 or (s.channel='email' and (length(btrim(p_body))=0 or length(btrim(p_subject))=0))
 or p_body ~ '[{}]' or p_subject ~ '[{}]' then raise exception using errcode='22023',message='Review recipient and message'; end if;
 select * into c from public.outreach_compose_commands where id=p_command;
 if found then
   if c.client_id<>p_client or c.actor_id<>auth.uid() or c.lead_id<>p_lead or c.sender_id<>p_sender
     or c.body_text<>p_body or c.subject<>p_subject or c.recipient<>destination
   then raise exception using errcode='22023',message='Command conflict'; end if;
   return outreach_private.compose_projection(c);
 end if;
 if not s.enabled or not w.enabled or not exists(select 1 from public.outreach_compose_settings where client_id=p_client and channel=s.channel and enabled for share)
 then raise exception using errcode='42501',message='Sending is not enabled'; end if;
 if exists(select 1 from public.outreach_compose_commands where sender_id=p_sender and lower(recipient)=lower(destination) and status<>'failed')
 then raise exception using errcode='22023',message='Outreach already recorded'; end if;
 insert into public.outreach_compose_commands(id,client_id,lead_id,sender_id,channel,actor_id,actor_role,sender_version,workspace_version,
 recipient,recipient_name,sender_name,sender_address,subject,body_text)
 values(p_command,p_client,p_lead,p_sender,s.channel,auth.uid(),r,s.version,w.version,destination,l->>'name',s.sender_label,s.sender_address,p_subject,p_body)
 returning * into c;
 return outreach_private.compose_projection(c);
end; $$;

-- Called again immediately before activation; service credentials do not bypass authority changes.
create function public.authorize_outreach_compose(p_command uuid,p_claim uuid,p_claim_first boolean default false) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_compose_commands%rowtype; s public.outreach_reply_senders%rowtype; w public.outreach_reply_workspaces%rowtype; l jsonb;
begin
 select * into c from public.outreach_compose_commands where id=p_command;
 if not found then return null; end if;
 if outreach_private.compose_access(c.client_id,c.actor_id,true)<>c.actor_role then return null; end if;
 select * into c from public.outreach_compose_commands where id=p_command for update;
 if c.status<>'preparing' or c.created_at<now()-interval '3 minutes' or p_claim is null
   or (p_claim_first and c.claim_token is not null) or (not p_claim_first and c.claim_token is distinct from p_claim) then return null; end if;
 select * into s from public.outreach_reply_senders where id=c.sender_id and enabled for share;
 if not found or s.version<>c.sender_version then return null; end if;
 select * into w from public.outreach_reply_workspaces where id=s.workspace_id and enabled for share;
 if not found or w.version<>c.workspace_version or not exists(select 1 from public.outreach_compose_settings where client_id=c.client_id and channel=c.channel and enabled for share) then return null; end if;
 l:=outreach_private.compose_lead(c.client_id,c.lead_id);
 if c.recipient is distinct from (case when c.channel='linkedin' then l->>'profile' else lower(l->>'email') end) then return null; end if;
 if exists(select 1 from public.outreach_leads where client_id=c.client_id and status in ('unsubscribed','bounced')
   and (c.channel='email' and lower(email)=lower(c.recipient) or c.channel='linkedin' and rtrim(regexp_replace(lower(linkedin_url),'^https://(www\.)?',''),'/')=rtrim(regexp_replace(lower(c.recipient),'^https://(www\.)?',''),'/')))
   or exists(select 1 from public.outreach_conversations where client_id=c.client_id and channel=c.channel and suppressed and rtrim(regexp_replace(lower(contact_address),'^https://(www\.)?',''),'/')=rtrim(regexp_replace(lower(c.recipient),'^https://(www\.)?',''),'/'))
 then return null; end if;
 if p_claim_first then update public.outreach_compose_commands set claim_token=p_claim where id=p_command; end if;
 return jsonb_build_object('command',outreach_private.compose_projection(c),'remoteSender',s.remote_sender_id,'workspace',w.remote_workspace_id,'credentialRef',w.credential_ref);
end; $$;

create function public.checkpoint_outreach_compose(p_command uuid,p_claim uuid,p_campaign text,p_list text default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c public.outreach_compose_commands%rowtype;
begin
 if public.authorize_outreach_compose(p_command,p_claim,false) is null then return false; end if;
 select * into c from public.outreach_compose_commands where id=p_command for update;
 if c.remote_campaign_id is not null or p_campaign is null or length(p_campaign) not between 1 and 200 then return false; end if;
 insert into public.outreach_campaigns(id,client_id,channel,provider_campaign_id,name,status)
 values(c.id,c.client_id,c.channel,p_campaign,left('Direct outreach · '||c.recipient_name,500),'draft');
 if c.channel='email' then
   insert into public.outreach_campaign_steps(campaign_id,client_id,step,variant,subject,body_text) values(c.id,c.client_id,0,0,c.subject,c.body_text);
 end if;
 -- Campaign assignment deliberately increments sender versions. Adopt only
 -- this transaction's own assignment change, under the workspace/sender locks.
 update public.outreach_compose_commands set remote_campaign_id=p_campaign,remote_list_id=p_list,
 sender_version=(select version from public.outreach_reply_senders where id=c.sender_id) where id=c.id;
 return true;
end; $$;

revoke all on function outreach_private.compose_access(uuid,uuid,boolean),outreach_private.compose_lead(uuid,uuid),outreach_private.compose_projection(public.outreach_compose_commands) from public,anon,authenticated,service_role;
revoke all on function public.get_outreach_compose(uuid,uuid,text),public.prepare_outreach_compose(uuid,uuid,uuid,uuid,text,text,text),public.authorize_outreach_compose(uuid,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.get_outreach_compose(uuid,uuid,text),public.prepare_outreach_compose(uuid,uuid,uuid,uuid,text,text,text) to authenticated;
grant execute on function public.authorize_outreach_compose(uuid,uuid,boolean) to service_role;
revoke all on function public.checkpoint_outreach_compose(uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.checkpoint_outreach_compose(uuid,uuid,text,text) to service_role;
