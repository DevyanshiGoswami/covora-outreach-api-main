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
  // They activated but left before joining. Re-adding them replaces the first link and, because
  // the login never joined anything, includes a fresh one-time sign-in so they can finish.
  await invitee.auth.signOut()
  const second = await call(onboarding.invite, tenant.supabase, { clientId: tenant.client.id, email, role: 'client_member' })
  assert.equal(second.status, 200); assert.match(second.body.loginToken, /^resume_[a-f0-9]{20,}$/); assert.match(second.body.notice, /never finished/)
  const resumed = anonClient()
  assert.ifError((await resumed.auth.verifyOtp({ token_hash: second.body.loginToken.slice('resume_'.length), type: 'email' })).error)
  assert.equal((await anonClient().auth.verifyOtp({ token_hash: second.body.loginToken.slice('resume_'.length), type: 'email' })).error?.code, 'otp_expired')
  assert.equal((await call(team.inspectInvitation, resumed, { token: first.body.token })).status, 403)
  assert.equal((await call(team.inspectInvitation, resumed, { token: second.body.token })).status, 200)
  // Resuming signs them in; they still create their own password before joining.
  assert.equal((await call(team.acceptInvitation, resumed, { token: second.body.token })).status, 409)
  assert.ifError((await resumed.auth.updateUser({ password: `Resumed-${randomUUID()}` })).error)
  assert.equal((await call(team.acceptInvitation, resumed, { token: second.body.token })).status, 200)
  assert.equal((await call(onboarding.invite, tenant.supabase, { clientId: tenant.client.id, email, role: 'client_member' })).status, 400)

  const rows = await events(tenant.client.id)
  const masked = `i***@example.test`
  assert.deepEqual(rows.map(r => [r.step, r.outcome, r.reason]), [
    ['create', 'ok', 'new_login'], ['inspect', 'failed', 'different_account'], ['create', 'ok', 'resumed_login'],
    ['inspect', 'failed', 'replaced_or_revoked'], ['inspect', 'ok', 'ok'], ['accept', 'failed', 'password_required'], ['accept', 'ok', 'ok'],
    ['create', 'failed', 'already_member']])
  assert.ok(rows.every(r => r.invitee === null || r.invitee === masked))
  assert.ok(!JSON.stringify(rows).includes(email) && !JSON.stringify(rows).includes(first.body.token))
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

test('a login that ever joined a workspace never gets a sign-in link from being added again', async t => {
  const first = await workspace(t), second = await workspace(t)
  const email = `joined-${randomUUID()}@example.test`
  const invited = await call(onboarding.invite, first.supabase, { clientId: first.client.id, email, role: 'client_member' })
  const person = anonClient(), verified = await person.auth.verifyOtp({ token_hash: invited.body.loginToken, type: 'invite' }); assert.ifError(verified.error)
  t.after(async () => { await admin.auth.admin.deleteUser(verified.data.user!.id) })
  assert.ifError((await person.auth.updateUser({ password: `Joined-${randomUUID()}` })).error)
  assert.equal((await call(team.acceptInvitation, person, { token: invited.body.token })).status, 200)
  const again = await call(onboarding.invite, second.supabase, { clientId: second.client.id, email, role: 'client_member' })
  assert.equal(again.status, 200); assert.equal(again.body.loginToken, null); assert.match(again.body.notice, /already has a login/)
  // A former member whose access was revoked is not "never finished" either.
  assert.ifError((await admin.from('outreach_memberships').update({ state: 'revoked' }).eq('user_id', verified.data.user!.id)).error)
  assert.equal((await call(onboarding.invite, second.supabase, { clientId: second.client.id, email, role: 'client_member' })).body.loginToken, null)
  assert.deepEqual((await events(second.client.id)).map(r => r.reason), ['existing_login', 'existing_login'])
  for (const session of [first.supabase, anonClient()]) assert.equal((await session.rpc('resumable_outreach_login', { p_user: verified.data.user!.id })).error?.code, '42501')
})

test('a sign-in link is withheld while another workspace or an agency owner is also waiting for the person', async t => {
  const first = await workspace(t), second = await workspace(t)
  const email = `shared-${randomUUID()}@example.test`
  const invited = await call(onboarding.invite, first.supabase, { clientId: first.client.id, email, role: 'client_member' })
  const person = anonClient(), verified = await person.auth.verifyOtp({ token_hash: invited.body.loginToken, type: 'invite' }); assert.ifError(verified.error)
  t.after(async () => { await admin.auth.admin.deleteUser(verified.data.user!.id) })
  // Another workspace adds them while the first invitation is pending, and the first re-adds them after that.
  const other = await call(onboarding.invite, second.supabase, { clientId: second.client.id, email, role: 'client_member' })
  assert.equal(other.status, 200); assert.equal(other.body.loginToken, null)
  assert.equal((await call(onboarding.invite, first.supabase, { clientId: first.client.id, email, role: 'client_member' })).body.loginToken, null)
  // Once only one workspace is waiting, re-adding gives the link again.
  assert.ifError((await admin.from('outreach_invitations').update({ status: 'revoked' }).eq('client_id', second.client.id).eq('email', email)).error)
  assert.match((await call(onboarding.invite, first.supabase, { clientId: first.client.id, email, role: 'client_member' })).body.loginToken, /^resume_/)
  // A pending agency-owner invitation for the same address also withholds it.
  assert.ifError((await admin.from('outreach_owner_invitations').insert({ email, invited_by: first.user.id, inviter_version: 1, token_hash: randomUUID() })).error)
  assert.equal((await call(onboarding.invite, first.supabase, { clientId: first.client.id, email, role: 'client_member' })).body.loginToken, null)
  assert.deepEqual((await events(first.client.id)).map(r => r.reason), ['new_login', 'existing_login', 'resumed_login', 'existing_login'])
})
