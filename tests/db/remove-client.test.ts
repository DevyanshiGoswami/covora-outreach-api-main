import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { adminClient, anonClient } from '../helpers/admin'
import { createTenant, createAdmin } from '../helpers/tenants'
import { grantOutreachMembership, grantOutreachOwner, grantAgencyControls } from '../helpers/outreach'
import { loadTestEnv } from '../helpers/env'
import { createOnboardingHandlers } from '../../src/lib/onboarding-api'

const admin = adminClient()
const env = loadTestEnv()
const handler = createOnboardingHandlers({ url: env.URL, anonKey: env.ANON, serviceKey: env.SERVICE, fetch,
  providerFetch: async () => { throw new Error('Removal must not call a provider') },
}).removeClient
async function request(session: ReturnType<typeof anonClient>, clientId: string, name: string) {
  const token = (await session.auth.getSession()).data.session?.access_token
  return new Request('http://localhost/api/onboarding/clients/remove', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ clientId, name }),
  })
}
test('only active owners can remove clients, with exact name confirmation enforced by SQL', async t => {
  const tenant = await createTenant(t, { features: ['outreach_app'] })
  const owner = await createAdmin(t); await grantOutreachOwner(owner.user.id); await grantAgencyControls(owner.user.id)
  const params = { p_client_id: tenant.client.id, p_name: tenant.client.name }
  assert.equal((await handler(await request(anonClient(), tenant.client.id, tenant.client.name))).status, 401)
  for (const role of ['client_admin', 'client_member', 'client_viewer', 'operator'] as const) {
    await grantOutreachMembership(tenant.user.id, tenant.client.id, role)
    assert.equal((await handler(await request(tenant.supabase, tenant.client.id, tenant.client.name))).status, 403)
    assert.equal((await tenant.supabase.rpc('remove_outreach_client', params)).error?.code, '42501')
  }
  assert.equal((await anonClient().rpc('remove_outreach_client', params)).error?.code, '42501')
  assert.equal((await admin.rpc('remove_outreach_client', params)).error?.code, '42501')
  assert.equal((await owner.supabase.rpc('remove_outreach_client', { ...params, p_name: 'Wrong client' })).error?.code, '22023')
  assert.ifError((await admin.from('outreach_agency_memberships').update({ state: 'suspended' }).eq('user_id', owner.user.id)).error)
  assert.equal((await handler(await request(owner.supabase, tenant.client.id, tenant.client.name))).status, 403)
  assert.equal((await admin.from('client_features').select('enabled').eq('client_id', tenant.client.id).single()).data?.enabled, true)
})
test('removal revokes only this client, retains history and identities, and is idempotent', async t => {
  const tenant = await createTenant(t, { features: ['outreach_app'] })
  const other = await createTenant(t, { features: ['outreach_app'] })
  const owner = await createAdmin(t); await grantOutreachOwner(owner.user.id); await grantAgencyControls(owner.user.id)
  await grantOutreachMembership(tenant.user.id, tenant.client.id)
  await grantOutreachMembership(tenant.user.id, other.client.id)
  const invitation = await owner.supabase.rpc('create_outreach_invitation', { p_client_id: tenant.client.id, p_email: other.user.email, p_role: 'client_member' })
  assert.ifError(invitation.error)
  const binding = { remote_workspace_id: randomUUID(), credential_ref: 'OUTREACH_INSTANTLY_REMOVAL_TEST', enabled: true }
  assert.ifError((await admin.from('outreach_account_workspaces').insert([{ ...binding, client_id: tenant.client.id }, { ...binding, client_id: other.client.id }])).error)
  const beforePeople = (await admin.from('outreach_people').select('id').eq('client_id', tenant.client.id)).data!
  assert.ok(beforePeople.length > 0)
  const connection = await tenant.supabase.rpc('prepare_outreach_connection', { p_person: beforePeople[0].id, p_channel: 'email', p_action: 'start' })
  assert.ifError(connection.error)
  for (let repeat = 0; repeat < 2; repeat++) {
    const response = await handler(await request(owner.supabase, tenant.client.id, tenant.client.name))
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(await response.json(), { ok: true })
  }
  for (const session of [tenant.supabase, owner.supabase]) {
    const workspaces = await session.from('client_outreach_workspaces').select('client_id')
    assert.ifError(workspaces.error)
    assert.ok(!workspaces.data!.some(row => row.client_id === tenant.client.id))
    assert.ok(workspaces.data!.some(row => row.client_id === other.client.id))
    assert.equal((await session.rpc('list_outreach_people', { p_client: tenant.client.id })).error?.code, '42501')
  }
  const membership = (await admin.from('outreach_memberships').select('state,version').eq('client_id', tenant.client.id).eq('user_id', tenant.user.id).single()).data!
  assert.equal(membership.state, 'revoked'); assert.equal(membership.version, 2)
  assert.equal((await admin.from('outreach_invitations').select('status').eq('id', invitation.data![0].invitation_id).single()).data?.status, 'revoked')
  assert.ok((await other.supabase.rpc('accept_outreach_invitation', { p_token: invitation.data![0].token })).error)
  assert.ifError((await admin.auth.admin.getUserById(tenant.user.id)).error)
  const claim = connection.data![0]
  assert.equal((await admin.rpc('finish_outreach_connection', { p_id: claim.connection_id, p_lease: claim.claim_token, p_state: 'connected', p_remote_account: tenant.user.email })).data, false)
  assert.equal((await admin.from('outreach_connection_reservations').select('person_id').eq('person_id', beforePeople[0].id)).data?.length, 1)
  assert.deepEqual((await admin.from('outreach_people').select('id').eq('client_id', tenant.client.id)).data, beforePeople)
  const bindings = (await admin.from('outreach_account_workspaces').select('client_id,enabled,credential_ref,remote_workspace_id').in('client_id', [tenant.client.id, other.client.id])).data!
  assert.equal(bindings.find(row => row.client_id === tenant.client.id)?.enabled, false)
  assert.deepEqual(bindings.find(row => row.client_id === other.client.id), { client_id: other.client.id, ...binding })
  assert.equal((await admin.from('outreach_onboarding_audit').select('id').eq('client_id', tenant.client.id).eq('event', 'client_removed')).data?.length, 1)
  assert.ifError((await owner.supabase.rpc('create_outreach_client', { p_id: tenant.client.id, p_name: tenant.client.name })).error)
  assert.equal((await admin.from('client_features').select('enabled').eq('client_id', tenant.client.id).single()).data?.enabled, false)
})
test('preview clients can be removed without granting live operations', async t => {
  const tenant = await createTenant(t, { features: [{ feature: 'outreach_app', config: { presentation_mode: 'preview' } }] })
  const owner = await createAdmin(t); await grantOutreachOwner(owner.user.id); await grantAgencyControls(owner.user.id)
  assert.ifError((await owner.supabase.rpc('remove_outreach_client', { p_client_id: tenant.client.id, p_name: tenant.client.name })).error)
  assert.equal((await admin.from('client_features').select('enabled').eq('client_id', tenant.client.id).single()).data?.enabled, false)
})
