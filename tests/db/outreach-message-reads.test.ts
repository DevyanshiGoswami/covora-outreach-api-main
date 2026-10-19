import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { createAdmin, createTenant } from '../helpers/tenants.ts'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach.ts'

const admin = adminClient()
async function fixture(t: TestContext) {
  const a = await createTenant(t, { features: ['outreach_app'] })
  const b = await createTenant(t, { features: ['outreach_app'] })
  const off = await createTenant(t)
  const owner = await createAdmin(t)
  await grantOutreachOwner(owner.user.id)
  // An owner with an explicit client membership must not see duplicate messages.
  await grantOutreachMembership(owner.user.id, a.client.id)
  for (const client of [a.client, b.client, off.client]) {
    for (const channel of ['email', 'linkedin'] as const) {
      const campaign = await admin.from('outreach_campaigns').insert({
        client_id: client.id, channel, name: 'Synthetic message read fixture',
        provider_campaign_id: channel === 'email' ? randomUUID() : String(parseInt(randomUUID().replaceAll('-', '').slice(0, 12), 16) + 1),
      }).select('id').single()
      assert.ifError(campaign.error)
      const messages = [
        { direction: 'received', client_read_at: null },
        { direction: 'received', client_read_at: '2026-10-01T00:00:00Z' },
        { direction: 'sent', client_read_at: null },
      ].map(row => ({ ...row, client_id: client.id, campaign_id: campaign.data!.id,
        thread_key: randomUUID(), provider_email_id: randomUUID(),
        subject: 'Synthetic subject', body_text: 'Synthetic body', sent_at: '2026-10-01T00:00:00Z',
      }))
      const inserted = await admin.from('outreach_messages').insert(messages)
      // The write boundary also refuses a non-email campaign in this mirror.
      if (channel === 'linkedin') assert.equal(inserted.error?.code, '42501')
      else assert.ifError(inserted.error)
    }
  }
  return { a, b, off, owner }
}

test('message reads and exact counts preserve all workspace roles, channel scope and private projections', async t => {
  const { a, b, off, owner } = await fixture(t)
  for (const role of ['client_admin', 'client_member', 'client_viewer', 'operator'] as const) {
    await grantOutreachMembership(a.user.id, a.client.id, role)
    const own = await a.supabase.from('client_outreach_messages').select('*')
    assert.ifError(own.error)
    assert.equal(own.data!.length, 3)
    assert.ok(own.data!.every(row => row.client_id === a.client.id && row.body_text === 'Synthetic body'))
    assert.equal(JSON.stringify(own.data).includes('provider_'), false)
    const count = await a.supabase.from('client_outreach_messages').select('id', { count: 'exact', head: true })
      .eq('client_id', a.client.id).eq('direction', 'received').is('client_read_at', null)
    assert.ifError(count.error); assert.equal(count.count, 1)
    const foreign = await a.supabase.from('client_outreach_messages').select('id').eq('client_id', b.client.id)
    assert.ifError(foreign.error); assert.deepEqual(foreign.data, [])
  }
  const owned = await owner.supabase.from('client_outreach_messages').select('id,client_id')
    .in('client_id', [a.client.id, b.client.id, off.client.id])
  assert.ifError(owned.error)
  assert.equal(owned.data!.length, 6)
  assert.equal(new Set(owned.data!.map(row => row.id)).size, 6)
  assert.ok(owned.data!.every(row => row.client_id !== off.client.id))
  for (const session of [a.supabase, owner.supabase, anonClient()]) {
    assert.ok((await session.from('outreach_messages').select('id')).error)
  }
  assert.ok((await anonClient().from('client_outreach_messages').select('id')).error)
})

test('message authorization rechecks membership and feature changes on the next request', async t => {
  const { a, b, owner } = await fixture(t)
  await grantOutreachMembership(a.user.id, a.client.id)
  const read = async () => {
    const result = await a.supabase.from('client_outreach_messages').select('id')
    assert.ifError(result.error)
    return result.data!.length
  }
  assert.equal(await read(), 3)
  for (const state of ['suspended', 'revoked'] as const) {
    assert.ifError((await admin.from('outreach_memberships').update({ state }).eq('user_id', a.user.id)).error)
    assert.equal(await read(), 0)
    await grantOutreachMembership(a.user.id, a.client.id)
    assert.equal(await read(), 3)
  }
  assert.ifError((await admin.from('client_features').update({ enabled: false })
    .eq('client_id', a.client.id).eq('feature', 'outreach_app')).error)
  assert.equal(await read(), 0)
  const ownerDisabled = await owner.supabase.from('client_outreach_messages').select('id').eq('client_id', a.client.id)
  assert.ifError(ownerDisabled.error); assert.deepEqual(ownerDisabled.data, [])
  assert.ifError((await admin.from('outreach_agency_memberships').update({ state: 'revoked' }).eq('user_id', owner.user.id)).error)
  const ownerRevoked = await owner.supabase.from('client_outreach_messages').select('id').eq('client_id', b.client.id)
  assert.ifError(ownerRevoked.error); assert.deepEqual(ownerRevoked.data, [])
  const unassigned = await b.supabase.from('client_outreach_messages').select('id')
  assert.ifError(unassigned.error); assert.deepEqual(unassigned.data, [])
})
