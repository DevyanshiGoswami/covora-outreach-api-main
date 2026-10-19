import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { adminClient, anonClient } from '../helpers/admin'
import { createAdmin, createTenant } from '../helpers/tenants'
import { grantOutreachOwner, grantAgencyControls } from '../helpers/outreach'
import { createOnboardingHandlers } from '../../src/lib/onboarding-api'
import { createOwnerHandlers } from '../../src/lib/outbound-owner-api'
import { loadTestEnv } from '../helpers/env'

const db = adminClient(), env = loadTestEnv()
const config = { url: env.URL, anonKey: env.ANON, serviceKey: env.SERVICE, fetch }
const onboarding = createOnboardingHandlers(config), owners = createOwnerHandlers(config)
async function request(session: ReturnType<typeof anonClient>, body: unknown) {
  const token = (await session.auth.getSession()).data.session!.access_token
  return new Request('http://localhost/action', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
test('ordinary owners keep agency access but cannot add/remove clients or remove owners, even by direct RPC', async t => {
  const owner = await createAdmin(t); await grantOutreachOwner(owner.user.id)
  const privileged = await createAdmin(t); await grantOutreachOwner(privileged.user.id); await grantAgencyControls(privileged.user.id)
  const tenant = await createTenant(t, { features: ['outreach_app'] })
  const id = randomUUID(); t.after(async () => { await db.from('clients').delete().eq('id', id) })
  const context = await owner.supabase.rpc('outreach_portal_context'); assert.ifError(context.error)
  assert.equal((context.data as { isOwner: boolean }).isOwner, true)
  assert.equal((context.data as { canManageClients: boolean }).canManageClients, false)
  const list = await owner.supabase.rpc('list_outreach_owners'); assert.ifError(list.error)
  assert.equal((list.data as { canRemoveOwners: boolean }).canRemoveOwners, false)
  assert.equal((await owner.supabase.rpc('create_outreach_client', { p_id: id, p_name: 'Denied' })).error?.code, '42501')
  assert.equal((await owner.supabase.rpc('remove_outreach_client', { p_client_id: tenant.client.id, p_name: tenant.client.name })).error?.code, '42501')
  assert.equal((await owner.supabase.rpc('revoke_outreach_owner', { p_user_id: privileged.user.id, p_expected_version: 1 })).error?.code, '42501')
  assert.equal((await onboarding.createClient(await request(owner.supabase, { id, name: 'Denied' }))).status, 403)
  assert.equal((await onboarding.removeClient(await request(owner.supabase, { clientId: tenant.client.id, name: tenant.client.name }))).status, 403)
  assert.equal((await owners.revokeOwner(await request(owner.supabase, { userId: privileged.user.id, expectedVersion: 1 }))).status, 403)
  for (const session of [owner.supabase, privileged.supabase, anonClient()]) {
    assert.equal((await session.from('outreach_agency_permissions').upsert({ user_id: owner.user.id, can_manage_clients: true, can_remove_owners: true })).error?.code, '42501')
    assert.equal((await session.from('outreach_agency_permissions').select('*')).error?.code, '42501')
  }
  // Ordinary owners can still invite. Accepting an invitation never grants the extra controls.
  const invited = await createAdmin(t)
  const invitation = await owner.supabase.rpc('create_outreach_owner_invitation', { p_email: invited.user.email }); assert.ifError(invitation.error)
  assert.ifError((await invited.supabase.rpc('accept_outreach_owner_invitation', { p_token: invitation.data![0].token })).error)
  assert.equal((await invited.supabase.rpc('create_outreach_client', { p_id: id, p_name: 'Denied' })).error?.code, '42501')
  assert.equal((await invited.supabase.rpc('revoke_outreach_owner', { p_user_id: privileged.user.id, p_expected_version: 1 })).error?.code, '42501')
})
test('explicit database grants permit exactly their actions and revocation applies to existing sessions', async t => {
  const manager = await createAdmin(t); await grantOutreachOwner(manager.user.id)
  const other = await createAdmin(t); await grantOutreachOwner(other.user.id)
  const id = randomUUID(); t.after(async () => { await db.from('clients').delete().eq('id', id) })
  assert.ifError((await db.from('outreach_agency_permissions').insert({ user_id: manager.user.id, can_manage_clients: true })).error)
  assert.equal((await onboarding.createClient(await request(manager.supabase, { id, name: 'Managed client' }))).status, 201)
  assert.equal((await manager.supabase.rpc('revoke_outreach_owner', { p_user_id: other.user.id, p_expected_version: 1 })).error?.code, '42501')
  assert.ifError((await db.from('outreach_agency_permissions').update({ can_manage_clients: false, can_remove_owners: true }).eq('user_id', manager.user.id)).error)
  assert.equal((await onboarding.removeClient(await request(manager.supabase, { clientId: id, name: 'Managed client' }))).status, 403)
  assert.ifError((await manager.supabase.rpc('revoke_outreach_owner', { p_user_id: other.user.id, p_expected_version: 1 })).error)
  await grantAgencyControls(manager.user.id)
  assert.equal((await onboarding.removeClient(await request(manager.supabase, { clientId: id, name: 'Managed client' }))).status, 200)
  assert.ifError((await db.from('outreach_agency_memberships').update({ state: 'suspended' }).eq('user_id', manager.user.id)).error)
  assert.equal((await manager.supabase.rpc('create_outreach_client', { p_id: id, p_name: 'Denied' })).error?.code, '42501')
  const context = await manager.supabase.rpc('outreach_portal_context'); assert.ifError(context.error)
  assert.equal((context.data as { canManageClients: boolean }).canManageClients, false)
})
test('granting controls does not invalidate existing owner invitations or change membership versions', async t => {
  const owner = await createAdmin(t); await grantOutreachOwner(owner.user.id)
  const target = await createAdmin(t)
  const invitation = await owner.supabase.rpc('create_outreach_owner_invitation', { p_email: target.user.email }); assert.ifError(invitation.error)
  await grantAgencyControls(owner.user.id)
  assert.equal((await db.from('outreach_agency_memberships').select('version').eq('user_id', owner.user.id).single()).data?.version, 1)
  assert.ifError((await target.supabase.rpc('accept_outreach_owner_invitation', { p_token: invitation.data![0].token })).error)
})
