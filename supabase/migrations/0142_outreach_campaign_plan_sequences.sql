begin;
-- Review copy is distinct from provider campaigns and has no dispatch hooks,
-- recipient assignments, sender credentials or launch state.
create function outreach_private.valid_campaign_sequence_steps(p_steps jsonb, p_channel text)
returns boolean language plpgsql immutable set search_path=pg_catalog,public,pg_temp as $$
declare item jsonb; ordinal bigint; previous_day integer := 0; day_value integer;
begin
  if p_channel is null or p_channel not in ('email','linkedin')
    or jsonb_typeof(p_steps) is distinct from 'array' then return false; end if;
  if jsonb_array_length(p_steps) not between 1 and 20 then return false; end if;
  for item,ordinal in select value,ordinality from jsonb_array_elements(p_steps) with ordinality loop
    if jsonb_typeof(item) is distinct from 'object'
      or item - array['position','dayOffset','subject','body','sameThread','stage'] <> '{}'::jsonb
      or jsonb_typeof(item->'position') is distinct from 'number'
      or coalesce(item->>'position','') !~ '^[0-9]{1,2}$'
      or (item->>'position')::integer <> ordinal
      or jsonb_typeof(item->'body') is distinct from 'string'
      or length(regexp_replace(item->>'body','[[:space:]]','','g'))=0
      or length(item->>'body') > 10000
      or translate(item->>'body',E'\n\r\t','') ~ '[[:cntrl:]]'
      or jsonb_typeof(item->'sameThread') is distinct from 'boolean'
      or jsonb_typeof(item->'stage') is distinct from 'string'
      or jsonb_typeof(item->'subject') is null
      or jsonb_typeof(item->'subject') not in ('null','string')
      or (jsonb_typeof(item->'subject')='string' and (
        length(btrim(item->>'subject')) not between 1 and 500 or length(item->>'subject')>500 or item->>'subject' ~ '[[:cntrl:]]'))
      or jsonb_typeof(item->'dayOffset') is null
      or jsonb_typeof(item->'dayOffset') not in ('null','number') then return false; end if;
    day_value := null;
    if jsonb_typeof(item->'dayOffset')='number' then
      if item->>'dayOffset' !~ '^[0-9]{1,3}$' then return false; end if;
      day_value := (item->>'dayOffset')::integer;
      if day_value>365 then return false; end if;
    end if;
    if p_channel='email' then
      if item->>'stage'<>'email' or day_value is null or day_value<previous_day
        or (ordinal=1 and (day_value<>0 or item->'sameThread'<>'false'::jsonb or jsonb_typeof(item->'subject')<>'string'))
        or (item->'sameThread'='true'::jsonb and item->'subject'<>'null'::jsonb)
        or (item->'sameThread'='false'::jsonb and jsonb_typeof(item->'subject')<>'string') then return false; end if;
      previous_day := day_value;
    elsif item->>'stage'<>'after_connection' or item->'subject'<>'null'::jsonb
      or item->'sameThread'<>'false'::jsonb then return false; end if;
  end loop;
  return true;
end; $$;
revoke all on function outreach_private.valid_campaign_sequence_steps(jsonb,text) from public,anon,authenticated,service_role;

alter table public.outreach_campaign_plans add constraint outreach_campaign_plan_tenant_channel unique(id,client_id,channel);
create table public.outreach_campaign_plan_sequences (
  plan_id uuid not null,
  client_id uuid not null,
  channel text not null check(channel in ('email','linkedin')),
  variant_key text not null check(length(variant_key) between 1 and 80 and variant_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  sort_order integer not null check(sort_order between 1 and 20),
  label text not null check(length(btrim(label)) between 1 and 200 and length(label)<=200 and label !~ '[[:cntrl:]]'),
  audience_label text not null check(length(btrim(audience_label)) between 1 and 500 and length(audience_label)<=500 and audience_label !~ '[[:cntrl:]]'),
  sender_label text check(length(btrim(sender_label)) between 1 and 200 and length(sender_label)<=200 and sender_label !~ '[[:cntrl:]]'),
  review_note text check(length(btrim(review_note)) between 1 and 2000 and length(review_note)<=2000 and review_note !~ '[[:cntrl:]]'),
  steps jsonb not null check(outreach_private.valid_campaign_sequence_steps(steps,channel)),
  source_filename text not null check(length(btrim(source_filename)) between 1 and 500 and length(source_filename)<=500 and source_filename !~ '[[:cntrl:]]'),
  source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
  source_version text not null check(length(btrim(source_version)) between 1 and 100 and length(source_version)<=100 and source_version !~ '[[:cntrl:]]'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(plan_id,variant_key),
  unique(plan_id,sort_order),
  foreign key(plan_id,client_id,channel) references public.outreach_campaign_plans(id,client_id,channel) on delete cascade
);
create trigger outreach_campaign_plan_sequence_updated before update on public.outreach_campaign_plan_sequences
  for each row execute function public.set_updated_at();
alter table public.outreach_campaign_plan_sequences enable row level security;
create policy outreach_campaign_plan_sequences_service on public.outreach_campaign_plan_sequences
  for all to service_role using(true) with check(true);
revoke all on public.outreach_campaign_plan_sequences from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.outreach_campaign_plan_sequences to service_role;
-- The internal validator is needed by service-only table constraints. It neither
-- reads tenant data nor returns it, and is not an exposed public RPC.
grant usage on schema outreach_private to service_role;
grant execute on function outreach_private.valid_campaign_sequence_steps(jsonb,text) to service_role;

create or replace function public.list_outreach_campaign_plans(p_client_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if auth.uid() is null or p_client_id is null or not outreach_private.can_read(p_client_id) then
    raise exception using errcode='42501',message='Campaign plan access denied';
  end if;
  return jsonb_build_object('campaigns',coalesce((select jsonb_agg(
    outreach_private.campaign_plan_projection(to_jsonb(p)) || jsonb_build_object('sequenceVariants',coalesce((
      select jsonb_agg(jsonb_build_object(
        'key',s.variant_key,'label',s.label,'audienceLabel',s.audience_label,
        'senderLabel',s.sender_label,'reviewNote',s.review_note,'steps',s.steps
      ) order by s.sort_order,s.variant_key)
      from public.outreach_campaign_plan_sequences s where s.plan_id=p.id and s.client_id=p_client_id and s.channel=p.channel
    ),'[]'::jsonb)) order by p.created_at,p.id)
    from outreach_private.read_campaign_plans(p_client_id) p),'[]'::jsonb));
end; $$;
revoke all on function public.list_outreach_campaign_plans(uuid) from public,anon,authenticated,service_role;
grant execute on function public.list_outreach_campaign_plans(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
