import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import type { Database, Json } from '../../src/lib/database.types.ts'
import { createOutboundCampaignPlanHandlers } from '../../src/lib/outbound-campaign-plans-api.ts'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { loadTestEnv } from '../helpers/env.ts'
import { createAdmin, createTenant } from '../helpers/tenants.ts'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach.ts'

const admin = adminClient()
type Sequence = Database['public']['Tables']['outreach_campaign_plan_sequences']['Insert']
const linkedinStep = { position: 1, dayOffset: null, subject: null, body: 'Hey {{first name}},\n\nGreat to connect. <Keep as plain text>', sameThread: false, stage: 'after_connection' }
const emailStep = { position: 1, dayOffset: 0, subject: '{{firstName}}, hello', body: 'Hello {{firstName}}\n\nExact copy retained.', sameThread: false, stage: 'email' }
async function fixture(t: TestContext) {
  const tenant = await createTenant(t, { features: [{ feature: 'outreach_app', config: { mode: 'preview' } }] })
  await grantOutreachMembership(tenant.user.id, tenant.client.id, 'client_viewer')
  const plans = [
    { id: randomUUID(), client_id: tenant.client.id, slug: 'manufacturer_linkedin', name: 'Manufacturer LinkedIn', audience: 'hiring_partners', channel: 'linkedin' },
    { id: randomUUID(), client_id: tenant.client.id, slug: 'manufacturer_email', name: 'Manufacturer Email', audience: 'hiring_partners', channel: 'email' },
    { id: randomUUID(), client_id: tenant.client.id, slug: 'athlete_linkedin', name: 'Athlete LinkedIn', audience: 'athletes', channel: 'linkedin' },
  ]
  assert.ifError((await admin.from('outreach_campaign_plans').insert(plans)).error)
  const sequence = (overrides: Partial<Sequence> = {}): Sequence => ({
    plan_id: plans[0].id, client_id: tenant.client.id, channel: 'linkedin', variant_key: 'tier_1', sort_order: 1,
    label: 'Tier 1', audience_label: 'Independent distributors', sender_label: null,
    review_note: 'Source copy retained for review.', steps: [linkedinStep],
    source_filename: 'Synthetic source.pdf', source_sha256: 'a'.repeat(64), source_version: 'test-v1', ...overrides,
  })
  return { tenant, plans, sequence }
}

test('draft sequence projection keeps exact copy, ordered variants and private provenance with no outbound side effects', async t => {
  const f = await fixture(t)
  const first = f.sequence(), second = f.sequence({ variant_key: 'tier_2', sort_order: 2, label: 'Tier 2' })
  assert.ifError((await admin.from('outreach_campaign_plan_sequences').insert([second, first])).error)
  const email = f.sequence({ plan_id: f.plans[1].id, channel: 'email', steps: [emailStep, { ...emailStep, position: 2, dayOffset: 3, sameThread: true, subject: null }] })
  assert.ifError((await admin.from('outreach_campaign_plan_sequences').insert(email)).error)
  const result = await f.tenant.supabase.rpc('list_outreach_campaign_plans', { p_client_id: f.tenant.client.id })
  assert.ifError(result.error)
  const env = loadTestEnv(), handler = createOutboundCampaignPlanHandlers({ url: env.URL, anonKey: env.ANON, fetch }).GET
  const token = (await f.tenant.supabase.auth.getSession()).data.session!.access_token
  const response = await handler(new Request(`https://api.invalid/api/outbound/campaign-plans?clientId=${f.tenant.client.id}`, { headers: { authorization: `Bearer ${token}` } }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  const linkedin = body.campaigns.find((row: { id: string }) => row.id === f.plans[0].id)
  assert.deepEqual(linkedin.sequenceVariants.map((row: { key: string }) => row.key), ['tier_1', 'tier_2'])
  assert.deepEqual(linkedin.sequenceVariants[0], { key: first.variant_key, label: first.label, audienceLabel: first.audience_label, senderLabel: null, reviewNote: first.review_note, steps: first.steps })
  assert.deepEqual(body.campaigns.find((row: { id: string }) => row.id === f.plans[2].id).sequenceVariants, [])
  assert.ok(body.campaigns.every((row: { status: string; leadCount: number }) => row.status === 'draft' && row.leadCount === 0))
  assert.doesNotMatch(JSON.stringify(body), /source_filename|source_sha256|source_version|Synthetic source|sender_id|recipient|provider_campaign/)
  for (const table of ['outreach_campaigns', 'outreach_sync_state', 'outreach_leads', 'outreach_fetch_queue', 'outreach_campaign_plan_memberships'] as const) {
    const result = await admin.from(table).select('*', { count: 'exact', head: true }).eq('client_id', f.tenant.client.id)
    assert.ifError(result.error); assert.equal(result.count, 0)
  }
  assert.ifError((await admin.from('outreach_campaign_plans').delete().eq('id', f.plans[0].id)).error)
  assert.equal((await admin.from('outreach_campaign_plan_sequences').select('*', { count: 'exact', head: true }).eq('plan_id', f.plans[0].id)).count, 0)
})

test('sequence tenants and channels cannot be crossed, and no user role can read raw data or mutate drafts', async t => {
  const a = await fixture(t), b = await fixture(t), outsider = await createAdmin(t), owner = await createAdmin(t)
  await grantOutreachOwner(owner.user.id)
  assert.ifError((await admin.from('outreach_campaign_plan_sequences').insert(a.sequence())).error)
  for (const bad of [a.sequence({ client_id: b.tenant.client.id, variant_key: 'tier_2', sort_order: 2 }), a.sequence({ channel: 'email', steps: [emailStep], variant_key: 'tier_2', sort_order: 2 })]) {
    assert.equal((await admin.from('outreach_campaign_plan_sequences').insert(bad)).error?.code, '23503')
  }
  for (const role of ['client_admin', 'client_member', 'client_viewer', 'operator'] as const) {
    assert.ifError((await admin.from('outreach_memberships').update({ role }).eq('user_id', a.tenant.user.id)).error)
    assert.ifError((await a.tenant.supabase.rpc('list_outreach_campaign_plans', { p_client_id: a.tenant.client.id })).error)
    assert.ok((await a.tenant.supabase.from('outreach_campaign_plan_sequences').insert(a.sequence({ variant_key: 'forbidden' }))).error)
  }
  for (const session of [a.tenant.supabase, b.tenant.supabase, owner.supabase, outsider.supabase, anonClient()]) {
    assert.ok((await session.from('outreach_campaign_plan_sequences').select('*')).error)
    assert.ok((await session.from('outreach_campaign_plan_sequences').update({ label: 'Forbidden' }).eq('client_id', a.tenant.client.id)).error)
    assert.ok((await session.from('outreach_campaign_plan_sequences').delete().eq('client_id', a.tenant.client.id)).error)
  }
  for (const session of [b.tenant.supabase, outsider.supabase, anonClient()]) assert.equal((await session.rpc('list_outreach_campaign_plans', { p_client_id: a.tenant.client.id })).error?.code, '42501')
  assert.ifError((await owner.supabase.rpc('list_outreach_campaign_plans', { p_client_id: a.tenant.client.id })).error)
  assert.ifError((await admin.from('outreach_memberships').update({ state: 'suspended' }).eq('user_id', a.tenant.user.id)).error)
  assert.equal((await a.tenant.supabase.rpc('list_outreach_campaign_plans', { p_client_id: a.tenant.client.id })).error?.code, '42501')
  assert.ifError((await admin.from('client_features').update({ enabled: false }).eq('client_id', a.tenant.client.id)).error)
  assert.equal((await owner.supabase.rpc('list_outreach_campaign_plans', { p_client_id: a.tenant.client.id })).error?.code, '42501')
})

test('sequence persistence rejects malformed JSON, extra fields, unsafe controls and unbounded content', async t => {
  const f = await fixture(t)
  const cases: Partial<Sequence>[] = [
    { variant_key: 'bad key' }, { sort_order: 21 }, { label: ' ' }, { label: 'x'.repeat(201) },
    { sender_label: 'x'.repeat(201) }, { review_note: 'x'.repeat(2001) }, { source_sha256: 'not a hash' },
    { steps: {} }, { steps: [] }, { steps: Array.from({ length: 21 }, (_, i) => ({ ...linkedinStep, position: i + 1 })) },
    { steps: [{ ...linkedinStep, position: 2 }] }, { steps: [{ ...linkedinStep, position: '1' }] },
    { steps: [{ ...linkedinStep, position: 1.5 }] }, { steps: [{ ...linkedinStep, sameThread: 'false' }] },
    { steps: [{ ...linkedinStep, body: '' }] }, { steps: [{ ...linkedinStep, body: '\n\t ' }] }, { steps: [{ ...linkedinStep, body: 'x'.repeat(10001) }] },
    { steps: [{ ...linkedinStep, body: 'bad\u0001control' }] }, { steps: [{ ...linkedinStep, dayOffset: 366 }] },
    { steps: [{ ...linkedinStep, dayOffset: -1 }] }, { steps: [{ ...linkedinStep, dayOffset: '0' }] },
    { steps: [{ ...linkedinStep, stage: 'email' }] }, { steps: [{ ...linkedinStep, subject: 'Wrong channel' }] },
    { steps: [{ ...linkedinStep, sameThread: true }] }, { steps: [{ ...linkedinStep, recipients: ['forbidden@example.test'] }] },
    { steps: [{ position: 1, body: 'Missing metadata' }] },
  ]
  for (const invalid of cases) assert.equal((await admin.from('outreach_campaign_plan_sequences').insert(f.sequence(invalid))).error?.code, '23514', JSON.stringify(invalid))
  assert.ifError((await admin.from('outreach_campaign_plan_sequences').insert(f.sequence())).error)
  assert.equal((await admin.from('outreach_campaign_plan_sequences').insert(f.sequence())).error?.code, '23505')
  assert.equal((await admin.from('outreach_campaign_plan_sequences').insert(f.sequence({ variant_key: 'tier_2' }))).error?.code, '23505')
})

test('email timing and threading constraints reject ambiguous or wrong channel steps', async t => {
  const f = await fixture(t)
  const follow = { ...emailStep, position: 2, dayOffset: 3, subject: null, sameThread: true }
  const invalidSteps: NonNullable<Json>[] = [
    [{ ...emailStep, dayOffset: 1 }], [{ ...emailStep, dayOffset: null }], [{ ...emailStep, subject: null }],
    [{ ...emailStep, sameThread: true }], [{ ...emailStep, stage: 'after_connection' }],
    [emailStep, { ...follow, subject: 'Not same thread' }], [emailStep, { ...follow, sameThread: false }],
    [emailStep, follow, { ...follow, position: 3, dayOffset: 2 }],
  ]
  for (const steps of invalidSteps) assert.equal((await admin.from('outreach_campaign_plan_sequences').insert(f.sequence({ plan_id: f.plans[1].id, channel: 'email', steps }))).error?.code, '23514')
  assert.ifError((await admin.from('outreach_campaign_plan_sequences').insert(f.sequence({ plan_id: f.plans[1].id, channel: 'email', steps: [emailStep, follow] }))).error)
})
