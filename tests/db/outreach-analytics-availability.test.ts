import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import type { Json } from '../../src/lib/database.types.ts'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { createTenant } from '../helpers/tenants.ts'
import { grantOutreachMembership } from '../helpers/outreach.ts'

const admin = adminClient()

test('neutral campaign totals preserve boolean availability and numeric metrics without provider fields', async t => {
  const a = await createTenant(t, { features: ['outreach_app'] })
  const b = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(a.user.id, a.client.id)
  await grantOutreachMembership(b.user.id, b.client.id)
  const campaigns = await admin.from('outreach_campaigns').insert([false, true].map(available => ({
    client_id: a.client.id, provider_campaign_id: randomUUID(), name: String(available),
    totals: {
      analytics_available: available, leads: 12, sent: 4, contacted: 0,
      unique_opened: '9', unique_replies: false, unique_auto_replies: null,
      positive_replies: { provider_id: 'hidden' }, unique_clicks: [1],
      provider_id: 'hidden', provider_count: 99, provider_available: true,
      provider_nested: { id: 'hidden' }, provider_list: ['hidden'],
    },
  }))).select('id')
  assert.ifError(campaigns.error)
  // The same generic metrics helper is used elsewhere and must stay numeric-only.
  assert.ifError((await admin.from('outreach_campaign_steps').insert({
    campaign_id: campaigns.data![0].id, client_id: a.client.id, step: 0,
    stats: { sent: 4, contacted: false, analytics_available: false, provider_count: 99 },
  })).error)
  const own = await a.supabase.from('client_outreach_campaigns').select('name,totals').order('name')
  assert.ifError(own.error)
  assert.deepEqual(own.data, [false, true].map(available => ({
    name: String(available), totals: { analytics_available: available, leads: 12, sent: 4, contacted: 0 },
  })))
  const steps = await a.supabase.from('client_outreach_campaign_steps').select('stats')
  assert.ifError(steps.error); assert.deepEqual(steps.data, [{ stats: { sent: 4 } }])
  const foreign = await b.supabase.from('client_outreach_campaigns').select('*')
  assert.ifError(foreign.error); assert.deepEqual(foreign.data, [])
  assert.ok((await anonClient().from('client_outreach_campaigns').select('*')).error)
  assert.ok((await a.supabase.from('outreach_campaigns').select('*')).error)
})

test('missing or malformed availability is omitted instead of coerced to a boolean', async t => {
  const a = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(a.user.id, a.client.id)
  const totals: NonNullable<Json>[] = [
    { sent: 7 },
    ...[null, 'false', 'true', 0, 1, [], {}, { provider_id: 'hidden' }].map(value => ({ sent: 7, analytics_available: value })),
    [], 'false', false, 0,
  ]
  assert.ifError((await admin.from('outreach_campaigns').insert(totals.map((value, index) => ({
    client_id: a.client.id, provider_campaign_id: randomUUID(), name: `Malformed ${String(index).padStart(2, '0')}`, totals: value,
  })))).error)
  const own = await a.supabase.from('client_outreach_campaigns').select('totals').order('name')
  assert.ifError(own.error)
  assert.deepEqual(own.data, totals.map(value => ({
    totals: value !== null && typeof value === 'object' && !Array.isArray(value) ? { sent: 7 } : {},
  })))
})

test('campaign projection retains its existing privilege and security boundary', () => {
  const label = execFileSync('docker', ['inspect', '--format', '{{index .Config.Labels "com.supabase.cli.project"}}', 'supabase_db_Covora_Outreach_API'], { encoding: 'utf8' }).trim()
  assert.equal(label, 'Covora_Outreach_API')
  const result = execFileSync('docker', ['exec', 'supabase_db_Covora_Outreach_API', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq', '-c', `
    select jsonb_build_object(
      'authenticated',has_function_privilege('authenticated','outreach_private.read_campaigns()','EXECUTE'),
      'anon',has_function_privilege('anon','outreach_private.read_campaigns()','EXECUTE'),
      'service_role',has_function_privilege('service_role','outreach_private.read_campaigns()','EXECUTE'),
      'public',exists(select 1 from aclexplode(p.proacl) where grantee=0 and privilege_type='EXECUTE'),
      'security_definer',p.prosecdef,'volatility',p.provolatile,'config',p.proconfig,
      'view_options',(select reloptions from pg_class where oid='public.client_outreach_campaigns'::regclass)
    ) from pg_proc p where p.oid='outreach_private.read_campaigns()'::regprocedure;
  `], { encoding: 'utf8' }).trim()
  assert.deepEqual(JSON.parse(result), {
    authenticated: true, anon: false, service_role: false, public: false,
    security_definer: true, volatility: 's', config: ['search_path=pg_catalog, public, pg_temp'],
    view_options: ['security_invoker=true', 'security_barrier=true'],
  })
})
