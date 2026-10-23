import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { adminClient, anonClient } from '../helpers/admin'
import { createTenant, createUser } from '../helpers/tenants'
import { grantOutreachMembership } from '../helpers/outreach'
import { createOnboardingHandlers } from '../../src/lib/onboarding-api'
import { createOutboundTeamHandlers } from '../../src/lib/outbound-team-api'
import { loadTestEnv } from '../helpers/env'

const admin = adminClient()
const env = loadTestEnv()
const config = { url: env.URL, anonKey: env.ANON, serviceKey: env.SERVICE, fetch }
const onboarding = createOnboardingHandlers(config)
const team = createOutboundTeamHandlers(config)
const post = (path: string, bearer: string, body: object) => new Request(`http://localhost${path}`, {
  method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bearer = async (session: ReturnType<typeof anonClient>) => (await session.auth.getSession()).data.session!.access_token

async function workspace(t: TestContext) {
  const tenant = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(tenant.user.id, tenant.client.id)
  const invite = async (email: string) => {
    const response = await onboarding.invite(post('/api/onboarding/invitations', await bearer(tenant.supabase), { clientId: tenant.client.id, email, role: 'client_member' }))
    assert.equal(response.status, 200)
    return await response.json() as { token: string; loginToken: string | null }
  }
  return { tenant, invite }
}
async function activate(t: TestContext, loginToken: string) {
  const session = anonClient()
  const verified = await session.auth.verifyOtp({ token_hash: loginToken, type: 'invite' })
  assert.ifError(verified.error)
  t.after(async () => { await admin.auth.admin.deleteUser(verified.data.user!.id) })
  return session
}
const inspect = async (session: ReturnType<typeof anonClient>, token: string) => {
  const result = await session.rpc('inspect_outreach_invitation', { p_token: token })
  assert.ifError(result.error)
  return result.data![0] as { status: string; password_required?: boolean }
}

test('a new invitee cannot accept until they create a password, however often the invitation is reopened', async t => {
  const { invite } = await workspace(t)
  const email = `new-${randomUUID()}@example.test`
  const created = await invite(email)
  assert.ok(created.loginToken)
  const session = await activate(t, created.loginToken!)
  const denied = await session.rpc('accept_outreach_invitation', { p_token: created.token })
  assert.equal(denied.error?.code, '22023', 'accepting without ever setting a password must be refused')
  assert.equal(denied.error?.message, 'Set a password first')
  for (let reopen = 0; reopen < 2; reopen++) assert.equal((await inspect(session, created.token)).password_required, true)
  const api = await team.acceptInvitation(post('/api/outbound/invitations/accept', await bearer(session), { token: created.token }))
  assert.equal(api.status, 409)
  assert.deepEqual(await api.json(), { error: 'Create your password before accepting this invitation.', passwordRequired: true })
  const inspected = await team.inspectInvitation(post('/api/outbound/invitations/inspect', await bearer(session), { token: created.token }))
  assert.equal((await inspected.json()).invitation.passwordRequired, true)

  const password = `Invitee-${randomUUID()}`
  assert.ifError((await session.auth.updateUser({ password })).error)
  assert.equal((await inspect(session, created.token)).password_required, false)
  const accepted = await team.acceptInvitation(post('/api/outbound/invitations/accept', await bearer(session), { token: created.token }))
  assert.equal(accepted.status, 200)
  assert.equal((await inspect(session, created.token)).status, 'accepted')
  assert.ifError((await session.auth.signOut()).error)
  assert.ifError((await anonClient().auth.signInWithPassword({ email, password })).error)
})

test('a re-added invitee who never set a password must still create one, even through the resume link', async t => {
  const { invite } = await workspace(t)
  const email = `reissued-${randomUUID()}@example.test`
  const first = await activate(t, (await invite(email)).loginToken!)
  await first.auth.signOut()
  const again = await invite(email)
  assert.match(again.loginToken ?? '', /^resume_/, 'the re-add returns a one-time resume link')
  const resumed = anonClient()
  assert.ifError((await resumed.auth.verifyOtp({ token_hash: again.loginToken!.slice('resume_'.length), type: 'email' })).error)
  assert.equal((await inspect(resumed, again.token)).password_required, true)
  assert.equal((await resumed.rpc('accept_outreach_invitation', { p_token: again.token })).error?.message, 'Set a password first')
  assert.ifError((await resumed.auth.updateUser({ password: `Resumed-${randomUUID()}` })).error)
  assert.equal((await inspect(resumed, again.token)).password_required, false)
  assert.ifError((await resumed.rpc('accept_outreach_invitation', { p_token: again.token })).error)
})

test('people who already have an account accept without a password step', async t => {
  const { tenant, invite } = await workspace(t)
  const existing = await createUser()
  t.after(async () => { await admin.auth.admin.deleteUser(existing.user.id) })
  const created = await invite(existing.user.email)
  assert.equal(created.loginToken, null)
  assert.equal((await inspect(existing.session, created.token)).password_required, false)
  assert.ifError((await existing.session.rpc('accept_outreach_invitation', { p_token: created.token })).error)
  const other = await invite(`other-${randomUUID()}@example.test`)
  assert.equal((await tenant.supabase.rpc('accept_outreach_invitation', { p_token: other.token })).error?.code, '42501', 'a different account still cannot see or accept it')
})
