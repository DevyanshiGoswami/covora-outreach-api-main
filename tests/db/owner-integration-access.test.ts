import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { adminClient } from '../helpers/admin'
import { createUser } from '../helpers/tenants'
import { grantOutreachOwner } from '../helpers/outreach'
import { loadTestEnv } from '../helpers/env'
import { createAdminIntegrationHandlers } from '../../src/lib/admin-integrations-api'

test('accepted agency owner can configure connectors; revocation removes access from the same session', async () => {
  const admin = adminClient()
  const env = loadTestEnv()
  const inviter = await createUser()
  const invitee = await createUser()
  const integrationId = randomUUID()
  let calls = 0
  const handlers = createAdminIntegrationHandlers({
    url: env.URL, anonKey: env.ANON, serviceKey: env.SERVICE, fetch,
    providerFetch: async () => { calls++; return new Response(null, { status: 204 }) },
  })
  const token = (await invitee.session.auth.getSession()).data.session!.access_token
  const request = (body?: object) => new Request('http://localhost/api/onboarding/admin-integrations', {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const save = { action: 'save', id: integrationId, version: 0, channel: 'linkedin',
    label: 'Synthetic shared administration', workspaceId: randomUUID(), apiKey: `synthetic-${randomUUID()}` }
  try {
    await grantOutreachOwner(inviter.user.id)
    assert.equal((await handlers.POST(request(save))).status, 403)
    assert.equal(calls, 0)
    const invitation = await inviter.session.rpc('create_outreach_owner_invitation', { p_email: invitee.user.email })
    assert.ifError(invitation.error)
    assert.ifError((await invitee.session.rpc('accept_outreach_owner_invitation', { p_token: invitation.data![0].token })).error)
    assert.equal((await handlers.POST(request(save))).status, 200)
    assert.equal(calls, 1)
    const listed = await handlers.GET(request())
    assert.equal(listed.status, 200)
    const body = await listed.text()
    assert.ok(body.includes(integrationId))
    assert.ok(!body.includes(save.apiKey))
    assert.ok(!body.includes(save.workspaceId))
    assert.equal((await handlers.POST(request({ action: 'remove', id: integrationId, version: 1 }))).status, 200)
    const membership = await admin.from('outreach_agency_memberships').select('version').eq('user_id', invitee.user.id).single()
    assert.ifError(membership.error)
    assert.ifError((await inviter.session.rpc('revoke_outreach_owner', { p_user_id: invitee.user.id, p_expected_version: membership.data!.version })).error)
    assert.equal((await handlers.GET(request())).status, 403)
    assert.equal((await handlers.POST(request(save))).status, 403)
    assert.equal(calls, 1)
  } finally {
    // Remove any unassigned synthetic connector through an authorized handler.
    const stored = await admin.from('outreach_integrations').select('version').eq('id', integrationId).maybeSingle()
    if (stored.data) {
      const ownerToken = (await inviter.session.auth.getSession()).data.session!.access_token
      await handlers.POST(new Request('http://localhost/api/onboarding/admin-integrations', {
        method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', id: integrationId, version: stored.data.version }),
      }))
    }
    assert.ifError((await admin.auth.admin.deleteUser(invitee.user.id)).error)
    assert.ifError((await admin.auth.admin.deleteUser(inviter.user.id)).error)
  }
})
