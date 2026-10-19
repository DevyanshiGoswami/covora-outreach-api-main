import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { adminClient, anonClient } from '../helpers/admin'
import { createTenant, createAdmin } from '../helpers/tenants'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach'
import { peopleSchema } from '../../src/lib/onboarding-contract'
import { createOnboardingHandlers } from '../../src/lib/onboarding-api'
import { loadTestEnv } from '../helpers/env'
const admin = adminClient()
async function people(session: ReturnType<typeof anonClient>, client: string) {
  const result = await session.rpc('list_outreach_people', { p_client: client }); assert.ifError(result.error)
  return peopleSchema.parse(result.data)
}
async function workspace(t: Parameters<typeof createTenant>[0]) {
  const tenant = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(tenant.user.id, tenant.client.id)
  assert.ifError((await admin.from('outreach_account_workspaces').insert({ client_id: tenant.client.id, credential_ref: `OUTREACH_INSTANTLY_${randomUUID().replaceAll('-', '').toUpperCase()}`, remote_workspace_id: randomUUID(), enabled: true })).error)
  return tenant
}
const begin = (id: string) => ({ p_person: id, p_channel: 'email', p_action: 'start' })

test('acceptance reconciles an existing sender once and preserves ID, name and connected account', async t => {
  const tenant = await workspace(t), member = await createAdmin(t)
  const manual = await tenant.supabase.rpc('create_outreach_person', { p_client_id: tenant.client.id, p_name: 'Saved sender name', p_email: member.user.email }); assert.ifError(manual.error)
  const claim = await tenant.supabase.rpc('prepare_outreach_connection', begin(manual.data!)); assert.ifError(claim.error)
  assert.equal((await admin.rpc('finish_outreach_connection', { p_id: claim.data![0].connection_id, p_lease: claim.data![0].claim_token!, p_state: 'connected', p_remote_account: member.user.email })).data, true)
  const invitation = await tenant.supabase.rpc('create_outreach_invitation', { p_client_id: tenant.client.id, p_email: member.user.email, p_role: 'client_member' }); assert.ifError(invitation.error)
  assert.equal((await people(tenant.supabase, tenant.client.id)).find(p => p.email === member.user.email)?.source, 'external')
  for (let i=0; i<2; i++) assert.ifError((await member.supabase.rpc('accept_outreach_invitation', { p_token: invitation.data![0].token })).error)
  const saved = (await people(tenant.supabase, tenant.client.id)).filter(p => p.email === member.user.email)
  assert.equal(saved.length, 1); assert.equal(saved[0].id, manual.data); assert.equal(saved[0].name, 'Saved sender name')
  assert.equal(saved[0].connections[0].state, 'connected'); assert.equal(saved[0].source, 'team'); assert.equal(saved[0].canConnect, false)
  const self = await people(member.supabase, tenant.client.id)
  assert.equal(self.length, 1); assert.equal(self[0].isSelf, true); assert.equal(self[0].canConnect, true)
  assert.ifError((await tenant.supabase.rpc('create_outreach_invitation', { p_client_id: tenant.client.id, p_email: `pending-${randomUUID()}@example.test`, p_role: 'client_member' })).error)
  assert.equal((await people(tenant.supabase, tenant.client.id)).length, 2)
})

test('only the linked member connects; managers see everyone; owners are not senders; revocation fences completion', async t => {
  const tenant = await workspace(t), other = await workspace(t), member = await createAdmin(t), owner = await createAdmin(t)
  await grantOutreachOwner(owner.user.id); await grantOutreachMembership(member.user.id, tenant.client.id, 'client_member')
  const self = (await people(member.supabase, tenant.client.id))[0]
  assert.equal((await people(owner.supabase, tenant.client.id)).length, 2)
  for (const session of [tenant.supabase, owner.supabase, other.supabase]) assert.equal((await session.rpc('prepare_outreach_connection', begin(self.id))).error?.code, '42501')
  assert.equal((await member.supabase.rpc('list_outreach_people', { p_client: other.client.id })).error?.code, '42501')
  const claim = await member.supabase.rpc('prepare_outreach_connection', begin(self.id)); assert.ifError(claim.error)
  const id = claim.data![0].connection_id, lease = claim.data![0].claim_token!
  assert.ok((await admin.rpc('read_outreach_connection', { p_id: id, p_lease: lease })).data)
  await grantOutreachMembership(member.user.id, tenant.client.id, 'client_viewer')
  assert.equal((await people(member.supabase, tenant.client.id))[0].canConnect, false)
  assert.equal((await member.supabase.rpc('prepare_outreach_connection', begin(self.id))).error?.code, '42501')
  assert.equal((await admin.rpc('read_outreach_connection', { p_id: id, p_lease: lease })).error?.code, '42501')
  assert.equal((await admin.rpc('finish_outreach_connection', { p_id: id, p_lease: lease, p_state: 'connected', p_remote_account: member.user.email })).data, false)
  assert.ifError((await admin.from('outreach_memberships').update({ state: 'suspended' }).eq('user_id', member.user.id)).error)
  assert.equal((await member.supabase.rpc('list_outreach_people', { p_client: tenant.client.id })).error?.code, '42501')
  assert.equal((await people(owner.supabase, tenant.client.id)).find(p => p.id === self.id)?.access, 'suspended')
})

test('linking a sender fences assisted sign-in and later email changes preserve the linked identity', async t => {
  const tenant = await workspace(t), member = await createAdmin(t)
  const manual = await tenant.supabase.rpc('create_outreach_person', { p_client_id: tenant.client.id, p_name: 'External', p_email: member.user.email }); assert.ifError(manual.error)
  const claim = await tenant.supabase.rpc('prepare_outreach_connection', begin(manual.data!)); assert.ifError(claim.error)
  await grantOutreachMembership(member.user.id, tenant.client.id, 'client_member')
  assert.equal((await admin.rpc('finish_outreach_connection', { p_id: claim.data![0].connection_id, p_lease: claim.data![0].claim_token!, p_state: 'connected', p_remote_account: member.user.email })).data, false)
  assert.equal((await tenant.supabase.rpc('prepare_outreach_connection', begin(manual.data!))).error?.code, '42501')
  assert.equal((await people(member.supabase, tenant.client.id))[0].connections[0].state, 'needs_review')
  assert.equal((await people(member.supabase, tenant.client.id))[0].connections[0].canContinue, false)
  assert.ifError((await admin.auth.admin.updateUserById(member.user.id, { email: `changed-${randomUUID()}@example.test`, email_confirm: true })).error)
  await grantOutreachMembership(member.user.id, tenant.client.id, 'client_member')
  const rows = await people(tenant.supabase, tenant.client.id)
  assert.equal(rows.filter(p => p.id === manual.data).length, 1); assert.equal(rows.find(p => p.id === manual.data)?.email, member.user.email)
})

test('client admin invites new members with password setup but cannot provision higher roles or another client', async t => {
  const tenant = await workspace(t), other = await workspace(t), env = loadTestEnv()
  const handlers = createOnboardingHandlers({ url: env.URL, anonKey: env.ANON, serviceKey: env.SERVICE, fetch })
  const token = (await tenant.supabase.auth.getSession()).data.session!.access_token
  const request = (body: object) => new Request('http://localhost/api/onboarding/invitations', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const email = `invited-${randomUUID()}@example.test`
  for (const role of ['client_admin', 'operator']) assert.equal((await handlers.invite(request({ clientId: tenant.client.id, email, role }))).status, 403)
  assert.equal((await handlers.invite(request({ clientId: other.client.id, email, role: 'client_member' }))).status, 403)
  const response = await handlers.invite(request({ clientId: tenant.client.id, email, role: 'client_member' })); assert.equal(response.status, 200)
  const body = await response.json(); assert.ok(body.loginToken); assert.equal((await people(tenant.supabase, tenant.client.id)).length, 1)
  const session = anonClient(), verified = await session.auth.verifyOtp({ token_hash: body.loginToken, type: 'invite' }); assert.ifError(verified.error)
  t.after(async () => { await admin.from('clients').delete().eq('id', tenant.client.id); await admin.auth.admin.deleteUser(verified.data.user!.id) })
  assert.ifError((await session.auth.updateUser({ password: `New-${randomUUID()}` })).error)
  assert.ifError((await session.rpc('accept_outreach_invitation', { p_token: body.token })).error)
  assert.equal((await people(session, tenant.client.id))[0].role, 'client_member')
  assert.ifError((await session.rpc('prepare_outreach_connection', begin((await people(session, tenant.client.id))[0].id))).error)
})
