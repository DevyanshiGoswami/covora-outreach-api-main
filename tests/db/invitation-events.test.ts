import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { adminClient, anonClient } from '../helpers/admin'
import { createTenant, createAdmin } from '../helpers/tenants'
import { grantOutreachMembership } from '../helpers/outreach'
import { loadTestEnv } from '../helpers/env'
import { createOnboardingHandlers } from '../../src/lib/onboarding-api'
import { createOutboundTeamHandlers } from '../../src/lib/outbound-team-api'

const env = loadTestEnv()
const admin = adminClient()
const config = { url: env.URL, anonKey: env.ANON, serviceKey: env.SERVICE, fetch }
const onboarding = createOnboardingHandlers(config), team = createOutboundTeamHandlers(config)
type Session = ReturnType<typeof anonClient>
async function call(handler: (request: Request) => Promise<Response>, session: Session, body: object) {
  const token = (await session.auth.getSession()).data.session!.access_token
  const response = await handler(new Request('http://localhost/api', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  return { status: response.status, body: await response.json() }
}
async function events(clientId: string) {
  const rows = await admin.from('outreach_invitation_events').select('step,outcome,reason,invitation_id,actor_user_id,invitee,detail').eq('client_id', clientId).order('id')
  assert.ifError(rows.error); return rows.data!
}
async function workspace(t: Parameters<typeof createTenant>[0]) {
  const tenant = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(tenant.user.id, tenant.client.id)
  return tenant
}

test('adding a user records each step, and a refused link records why', async t => {
  const tenant = await workspace(t), stranger = await createAdmin(t)
  const email = `invited-${randomUUID()}@example.test`
  const first = await call(onboarding.invite, tenant.supabase, { clientId: tenant.client.id, email, role: 'client_member' })
  assert.equal(first.status, 200); assert.ok(first.body.loginToken)
  const invitee = anonClient(), verified = await invitee.auth.verifyOtp({ token_hash: first.body.loginToken, type: 'invite' }); assert.ifError(verified.error)
  t.after(async () => { await admin.auth.admin.deleteUser(verified.data.user!.id) })

  assert.equal((await call(team.inspectInvitation, stranger.supabase, { token: first.body.token })).status, 403)
  // Re-adding the same person replaces the first link, and the login already exists without any access.
  const second = await call(onboarding.invite, tenant.supabase, { clientId: tenant.client.id, email, role: 'client_member' })
  assert.equal(second.status, 200); assert.equal(second.body.loginToken, null)
  assert.equal((await call(team.inspectInvitation, invitee, { token: first.body.token })).status, 403)
  assert.equal((await call(team.inspectInvitation, invitee, { token: second.body.token })).status, 200)
  assert.equal((await call(team.acceptInvitation, invitee, { token: second.body.token })).status, 200)
  assert.equal((await call(onboarding.invite, tenant.supabase, { clientId: tenant.client.id, email, role: 'client_member' })).status, 400)

  const rows = await events(tenant.client.id)
  const masked = `i***@example.test`
  assert.deepEqual(rows.map(r => [r.step, r.outcome, r.reason]), [
    ['create', 'ok', 'new_login'], ['inspect', 'failed', 'different_account'], ['create', 'ok', 'existing_login'],
    ['inspect', 'failed', 'replaced_or_revoked'], ['inspect', 'ok', 'ok'], ['accept', 'ok', 'ok'], ['create', 'failed', 'already_member']])
  assert.ok(rows.every(r => r.invitee === null || r.invitee === masked))
  assert.ok(!JSON.stringify(rows).includes(email) && !JSON.stringify(rows).includes(first.body.token))
  assert.match(rows[2].detail ?? '', /no workspace access yet/)
  assert.equal(rows[0].actor_user_id, tenant.user.id); assert.equal(rows[1].actor_user_id, stranger.user.id)
  assert.equal(rows[0].invitation_id, first.body.invitationId); assert.equal(rows[3].invitation_id, first.body.invitationId)
})

test('an expired link and a role the inviter may not grant are recorded with their reasons', async t => {
  const tenant = await workspace(t), member = await createAdmin(t)
  await grantOutreachMembership(member.user.id, tenant.client.id, 'client_member')
  const denied = await call(onboarding.invite, member.supabase, { clientId: tenant.client.id, email: `x-${randomUUID()}@example.test`, role: 'client_member' })
  assert.equal(denied.status, 403)
  const target = await createAdmin(t)
  const created = await call(onboarding.invite, tenant.supabase, { clientId: tenant.client.id, email: target.user.email, role: 'client_viewer' })
  assert.ifError((await admin.from('outreach_invitations').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', created.body.invitationId)).error)
  assert.equal((await call(team.acceptInvitation, target.supabase, { token: created.body.token })).status, 403)
  const rows = await events(tenant.client.id)
  assert.deepEqual(rows.map(r => [r.step, r.outcome, r.reason]), [['create', 'failed', 'not_allowed'], ['create', 'ok', 'existing_login'], ['accept', 'failed', 'expired']])
})

test('only the server can read invitation events or ask why a link was refused', async t => {
  const tenant = await workspace(t)
  assert.equal((await tenant.supabase.from('outreach_invitation_events').select('*')).error?.code, '42501')
  assert.equal((await tenant.supabase.rpc('diagnose_outreach_invitation', { p_token: 'a'.repeat(64) })).error?.code, '42501')
  assert.equal((await anonClient().rpc('diagnose_outreach_invitation', { p_token: 'a'.repeat(64) })).error?.code, '42501')
  const unknown = await admin.rpc('diagnose_outreach_invitation', { p_token: 'a'.repeat(64) }); assert.ifError(unknown.error)
  assert.equal(unknown.data![0].reason, 'unknown_link')
})
