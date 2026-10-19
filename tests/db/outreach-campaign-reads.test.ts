import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { createAdmin, createTenant } from '../helpers/tenants.ts'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach.ts'

const admin = adminClient()
const views = ['client_outreach_campaigns', 'client_outreach_campaign_steps', 'client_outreach_campaign_daily', 'client_outreach_leads'] as const
async function fixture(t: TestContext) {
  const a = await createTenant(t, { features: ['outreach_app'] })
  const b = await createTenant(t, { features: ['outreach_app'] })
  const off = await createTenant(t)
  const owner = await createAdmin(t)
  await grantOutreachOwner(owner.user.id)
  await grantOutreachMembership(owner.user.id, a.client.id)
  for (const client of [a.client, b.client, off.client]) {
    for (const channel of ['email', 'linkedin'] as const) {
      const row = await admin.from('outreach_campaigns').insert({ client_id: client.id, channel,
        name: 'Synthetic campaign read fixture', totals: { sent: 10, analytics_available: false, private_field: 99 },
        provider_campaign_id: channel === 'email' ? randomUUID() : String(parseInt(randomUUID().replaceAll('-', '').slice(0, 12), 16) + 1),
      }).select('id').single()
      assert.ifError(row.error)
      const scope = { client_id: client.id, campaign_id: row.data!.id }
      assert.ifError((await admin.from('outreach_campaign_steps').insert({ ...scope, step: 0, stats: { sent: 10, private_field: 99 } })).error)
      assert.ifError((await admin.from('outreach_campaign_daily').insert({ ...scope, day: '2026-10-01', sent: 10 })).error)
      assert.ifError((await admin.from('outreach_leads').insert({ ...scope, email: `${randomUUID()}@example.test` })).error)
    }
  }
  return { a, b, off, owner }
}

test('campaign projections preserve all tenant roles, email-only scope and owner deduplication', async t => {
  const { a, b, off, owner } = await fixture(t)
  for (const role of ['client_admin', 'client_member', 'client_viewer', 'operator'] as const) {
    await grantOutreachMembership(a.user.id, a.client.id, role)
    for (const view of views) {
      const own = await a.supabase.from(view).select('client_id')
      assert.ifError(own.error); assert.deepEqual(own.data, [{ client_id: a.client.id }])
      const foreign = await a.supabase.from(view).select('client_id').eq('client_id', b.client.id)
      assert.ifError(foreign.error); assert.deepEqual(foreign.data, [])
    }
  }
  for (const view of views) {
    const result = await owner.supabase.from(view).select('client_id').in('client_id', [a.client.id, b.client.id, off.client.id])
    assert.ifError(result.error)
    assert.deepEqual(result.data!.map(row => row.client_id).sort(), [a.client.id, b.client.id].sort())
    assert.ok((await anonClient().from(view).select('client_id')).error)
  }
  const campaign = await a.supabase.from('client_outreach_campaigns').select('totals').single()
  assert.ifError(campaign.error); assert.deepEqual(campaign.data!.totals, { sent: 10, analytics_available: false })
  const step = await a.supabase.from('client_outreach_campaign_steps').select('stats').single()
  assert.ifError(step.error); assert.deepEqual(step.data!.stats, { sent: 10 })
  for (const table of ['outreach_campaigns', 'outreach_campaign_steps', 'outreach_campaign_daily', 'outreach_leads'] as const) {
    assert.ok((await owner.supabase.from(table).select('client_id')).error)
    assert.ok((await a.supabase.from(table).select('client_id')).error)
  }
})

test('campaign readers immediately observe revoked memberships and disabled workspace features', async t => {
  const { a, b, owner } = await fixture(t)
  for (const state of ['suspended', 'revoked'] as const) {
    await grantOutreachMembership(a.user.id, a.client.id)
    assert.ifError((await admin.from('outreach_memberships').update({ state }).eq('user_id', a.user.id)).error)
    for (const view of views) {
      const result = await a.supabase.from(view).select('client_id')
      assert.ifError(result.error); assert.deepEqual(result.data, [])
    }
  }
  await grantOutreachMembership(a.user.id, a.client.id)
  assert.ifError((await admin.from('client_features').update({ enabled: false }).eq('client_id', a.client.id).eq('feature', 'outreach_app')).error)
  for (const session of [a.supabase, owner.supabase]) {
    for (const view of views) {
      const result = await session.from(view).select('client_id').eq('client_id', a.client.id)
      assert.ifError(result.error); assert.deepEqual(result.data, [])
    }
  }
  assert.ifError((await admin.from('outreach_agency_memberships').update({ state: 'revoked' }).eq('user_id', owner.user.id)).error)
  for (const view of views) {
    const result = await owner.supabase.from(view).select('client_id').eq('client_id', b.client.id)
    assert.ifError(result.error); assert.deepEqual(result.data, [])
  }
})
