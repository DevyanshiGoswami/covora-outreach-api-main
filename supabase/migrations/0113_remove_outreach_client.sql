-- Removal archives a workspace; it never deletes Auth identities, provider
-- credentials, sender reservations or correspondence, and never calls providers.
alter table public.outreach_onboarding_audit drop constraint outreach_onboarding_audit_event_check;
alter table public.outreach_onboarding_audit add constraint outreach_onboarding_audit_event_check
  check(event in ('client_created','person_created','workspace_bound','connection_started','connection_finished','client_removed'));
create unique index outreach_client_removed_once on public.outreach_onboarding_audit(client_id) where event='client_removed';

create function public.remove_outreach_client(p_client_id uuid,p_name text) returns void
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare client_name text;
begin
  -- Use the same client lock/order as invitations, connections and reply dispatch.
  select name into client_name from public.clients where id=p_client_id for no key update;
  if not found then raise exception using errcode='42501',message='Client removal denied'; end if;
  perform 1 from public.outreach_agency_memberships where user_id=auth.uid() and state='active' for share;
  if not found then raise exception using errcode='42501',message='Client removal denied'; end if;
  if p_name is null or p_name<>client_name then
    raise exception using errcode='22023',message='Client name does not match';
  end if;
  -- A lost success response can be retried, without reviving or re-removing data.
  if exists(select 1 from public.outreach_onboarding_audit where client_id=p_client_id and event='client_removed') then return; end if;
  perform 1 from public.client_features where client_id=p_client_id and feature='outreach_app' and enabled for update;
  if not found then raise exception using errcode='42501',message='Client removal denied'; end if;
  -- An external send already in progress must finish or become uncertain first.
  perform outreach_private.expire_replies(p_client_id);
  if exists(select 1 from public.outreach_reply_commands where client_id=p_client_id and status='sending') then
    raise exception using errcode='55000',message='Reply in progress';
  end if;
  update public.outreach_reply_commands set status='cancelled',error_code='context_changed',updated_at=clock_timestamp()
    where client_id=p_client_id and status in ('queued','preparing');
  update public.outreach_invitations set status='revoked' where client_id=p_client_id and status='pending';
  update public.outreach_memberships set state='revoked' where client_id=p_client_id and state<>'revoked';
  update public.outreach_account_workspaces set enabled=false,version=version+1,updated_at=clock_timestamp() where client_id=p_client_id;
  update public.outreach_reply_workspaces set enabled=false,sync_enabled=false where client_id=p_client_id;
  update public.client_features set enabled=false where client_id=p_client_id and feature='outreach_app';
  insert into public.outreach_onboarding_audit(client_id,actor_id,subject_id,event)
    values(p_client_id,auth.uid(),p_client_id,'client_removed');
end; $$;
revoke all on function public.remove_outreach_client(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.remove_outreach_client(uuid,text) to authenticated;
