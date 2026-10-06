-- The reply inbox admits email threads only after receiving an inbound message.
-- Keep every sent message in the mirrored thread for history and human followups.
create or replace function public.list_outreach_conversations(p_client_id uuid,p_channel text default 'all',p_limit integer default 51,p_before_at timestamptz default null,p_before_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare result jsonb;
begin
  if not outreach_private.can_read(p_client_id) then raise exception using errcode='42501',message='Conversation access denied'; end if;
  if p_channel is null or p_channel not in ('all','email','linkedin') or p_limit is null or p_limit not between 1 and 100 or (p_before_at is null)<>(p_before_id is null) then raise exception using errcode='22023',message='Invalid conversation request'; end if;
  select coalesce(jsonb_agg(outreach_private.conversation_summary(q) order by q.latest_at desc,q.id desc),'[]'::jsonb) into result
    from (select c.* from public.outreach_conversations c where c.client_id=p_client_id and outreach_private.conversation_campaign_allowed(c) and (p_channel='all' or c.channel=p_channel)
      and (c.channel<>'email' or exists(select 1 from public.outreach_conversation_messages m where m.conversation_id=c.id and m.client_id=c.client_id and m.direction='received'))
      and (p_before_at is null or (c.latest_at,c.id)<(p_before_at,p_before_id)) order by c.latest_at desc,c.id desc limit p_limit) q;
  return result;
end; $$;
