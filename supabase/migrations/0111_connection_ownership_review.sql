-- Explain a fenced sign-in as needing review instead of offering an unusable continuation.
create function outreach_private.person_session_current(p_person uuid,p_actor uuid,p_stamp text) returns boolean
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select coalesce(outreach_private.person_can_connect(p_person,p_actor) and p_stamp=(select
    case when p.source='team' then 'team:'||p_actor::text||':'||m.version::text
      when a.state='active' then 'agency_owner:'||a.version::text
      else m.role||':'||m.version::text end
    from public.outreach_people p
    left join public.outreach_memberships m on m.client_id=p.client_id and m.user_id=p_actor
    left join public.outreach_agency_memberships a on a.user_id=p_actor
    where p.id=p_person),false);
$$;
revoke all on function outreach_private.person_session_current(uuid,uuid,text) from public,anon,authenticated,service_role;

create or replace function public.list_outreach_people(p_client uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if not outreach_private.can_read(p_client) then raise exception using errcode='42501',message='People unavailable'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'email',p.email,
    'source',p.source,'isSelf',coalesce(p.user_id=auth.uid(),false),
    'role',(select role from public.outreach_memberships where client_id=p.client_id and user_id=p.user_id),
    'access',case when p.source='external' then null else coalesce((select state from public.outreach_memberships where client_id=p.client_id and user_id=p.user_id),'revoked') end,
    'canConnect',outreach_private.person_can_connect(p.id,auth.uid()),
    'connections',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'channel',c.channel,
      'state',case when c.state in ('starting','pending') and not outreach_private.person_session_current(p.id,c.actor_id,c.authority_stamp) then 'needs_review'
        when c.state in ('starting','pending') and c.lease_until<now() then 'uncertain'
        when c.state in ('starting','pending') and c.expires_at<now() then 'expired'
        when c.state='connected' and not (case when c.channel='email' then exists(select 1 from public.outreach_account_workspaces w join public.outreach_accounts a on a.client_id=w.client_id where w.client_id=c.client_id and w.enabled and w.version=c.workspace_version and a.email=c.expected_email and a.state='connected')
          else exists(select 1 from public.outreach_reply_workspaces w where w.client_id=c.client_id and w.channel='linkedin' and w.enabled and w.version=c.workspace_version) end) then 'needs_review'
        else c.state end,
      'canContinue',c.actor_id=auth.uid() and outreach_private.person_session_current(p.id,c.actor_id,c.authority_stamp),'updatedAt',c.updated_at)) from
      (select distinct on(channel) * from public.outreach_connections where person_id=p.id order by channel,created_at desc,id desc) c),'[]'::jsonb)) order by p.created_at,p.id)
    from public.outreach_people p where p.client_id=p_client and (outreach_private.workspace_role(p_client) in ('agency_owner','client_admin','operator') or p.user_id=auth.uid())),'[]'::jsonb);
end; $$;
notify pgrst,'reload schema';
