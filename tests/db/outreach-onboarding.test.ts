import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { adminClient, anonClient } from '../helpers/admin'
import { createTenant, createAdmin } from '../helpers/tenants'
import { grantOutreachMembership, grantOutreachOwner, grantAgencyControls } from '../helpers/outreach'
import { loadTestEnv } from '../helpers/env'
import { createOnboardingHandlers } from '../../src/lib/onboarding-api'
import { peopleSchema, portalContextSchema } from '../../src/lib/onboarding-contract'

const env = loadTestEnv()
const admin = adminClient()
function config(providerFetch: typeof fetch = async () => { throw new Error('Unexpected provider call') }) {
  return { url: env.URL, anonKey: env.ANON, serviceKey: env.SERVICE, fetch, providerFetch,
    credentials: { OUTREACH_INSTANTLY_TEST: 'synthetic', OUTREACH_HEYREACH_TEST: 'synthetic' } }
}
async function setup(t: Parameters<typeof createTenant>[0]) {
  const tenant = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(tenant.user.id, tenant.client.id)
  const workspace = randomUUID()
  assert.ifError((await admin.from('outreach_account_workspaces').insert({ client_id: tenant.client.id, credential_ref: 'OUTREACH_INSTANTLY_TEST', remote_workspace_id: workspace, enabled: true })).error)
  const person = await tenant.supabase.rpc('create_outreach_person', { p_client_id: tenant.client.id, p_name: 'Test person', p_email: tenant.user.email })
  assert.ifError(person.error)
  return { ...tenant, workspace, person: person.data! }
}
async function request(session: ReturnType<typeof anonClient>, path: string, body?: unknown) {
  const token = (await session.auth.getSession()).data.session!.access_token
  return new Request(`http://localhost/api/onboarding/${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
}
test('owner creates clients; other roles cannot; direct private table/RPC access denied', async t => {
  const owner = await createAdmin(t); await grantOutreachOwner(owner.user.id); await grantAgencyControls(owner.user.id)
  const id = randomUUID(); t.after(async () => { await admin.from('clients').delete().eq('id', id) })
  const created = await owner.supabase.rpc('create_outreach_client', { p_id: id, p_name: 'New customer' }); assert.ifError(created.error)
  const ctx = portalContextSchema.parse((await owner.supabase.rpc('outreach_portal_context')).data)
  assert.equal(ctx.isOwner, true); assert.ok(ctx.workspaces.some(row => row.id === id))
  const tenant = await setup(t)
  assert.equal((await tenant.supabase.rpc('create_outreach_client', { p_id: randomUUID(), p_name: 'Denied' })).error?.code, '42501')
  for (const name of ['outreach_people', 'outreach_connections', 'outreach_connection_reservations', 'outreach_onboarding_audit'] as const) assert.equal((await tenant.supabase.from(name).select('*')).error?.code, '42501')
  assert.equal((await tenant.supabase.rpc('read_outreach_connection', { p_id: randomUUID(), p_lease: randomUUID() })).error?.code, '42501')
  assert.equal((await anonClient().rpc('outreach_portal_context')).error?.code, '42501')
})
test('workspace assignment metadata distinguishes disabled, unlisted and unassigned connections and stays owner-only', async t => {
  const tenant = await setup(t)
  const owner = await createAdmin(t); await grantOutreachOwner(owner.user.id)
  const foreign = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(foreign.user.id, foreign.client.id)
  const linkedWorkspace = randomUUID()
  assert.ifError((await admin.from('outreach_reply_workspaces').insert({ client_id: tenant.client.id, channel: 'linkedin', credential_ref: 'OUTREACH_HEYREACH_TEST', remote_workspace_id: linkedWorkspace, enabled: true })).error)
  const handlers = createOnboardingHandlers({ ...config(), workspaces: [
    { id: 'wrong-workspace', label: 'Wrong connection', channel: 'email', workspaceId: randomUUID(), credentialRef: 'OUTREACH_INSTANTLY_TEST' },
    { id: 'selected-email', label: 'Selected email connection', channel: 'email', workspaceId: tenant.workspace, credentialRef: 'OUTREACH_INSTANTLY_TEST' },
    { id: 'selected-social', label: 'Selected social connection', channel: 'linkedin', workspaceId: linkedWorkspace, credentialRef: 'OUTREACH_HEYREACH_TEST' },
  ] })
  const read = async () => {
    const response = await handlers.integrations(await request(owner.supabase, `integrations?clientId=${tenant.client.id}`))
    assert.equal(response.status, 200); return response.json()
  }
  const initial = await read()
  assert.deepEqual(initial.assignments, { email: { optionId: 'selected-email', label: 'Selected email connection', enabled: true }, linkedin: { optionId: 'selected-social', label: 'Selected social connection', enabled: true } })
  assert.ifError((await admin.from('outreach_account_workspaces').update({enabled:false}).eq('client_id', tenant.client.id)).error)
  const disabled = await read()
  assert.equal(disabled.assignments.email.optionId, 'selected-email'); assert.equal(disabled.assignments.email.enabled, false); assert.equal(disabled.status.email, false)
  const unlisted = await createOnboardingHandlers(config()).integrations(await request(owner.supabase, `integrations?clientId=${tenant.client.id}`))
  assert.deepEqual((await unlisted.json()).assignments.email, { optionId: null, label: 'Connection configured outside Integrations', enabled: false })
  for (const role of ['client_admin', 'operator', 'client_viewer'] as const) {
    await grantOutreachMembership(tenant.user.id, tenant.client.id, role)
    const response = await handlers.integrations(await request(tenant.supabase, `integrations?clientId=${tenant.client.id}`))
    const body = await response.json(); assert.equal(body.assignments, undefined); assert.deepEqual(body.options, [])
  }
  assert.equal((await handlers.integrations(await request(foreign.supabase, `integrations?clientId=${tenant.client.id}`))).status, 403)
  const empty = await handlers.integrations(await request(owner.supabase, `integrations?clientId=${foreign.client.id}`))
  assert.equal((await empty.json()).assignments.linkedin, null)
})
test('members can connect themselves; viewers are read-only; only managers add external senders', async t => {
  const tenant = await setup(t); const outsider = await createTenant(t, { features: ['outreach_app'] })
  for (const role of ['client_member', 'client_viewer'] as const) {
    await grantOutreachMembership(tenant.user.id, tenant.client.id, role)
    assert.ifError((await tenant.supabase.rpc('list_outreach_people', { p_client: tenant.client.id })).error)
    assert.equal((await tenant.supabase.rpc('create_outreach_person', { p_client_id: tenant.client.id, p_name: 'Denied', p_email: 'denied@example.test' })).error?.code, '42501')
    const connection = await tenant.supabase.rpc('prepare_outreach_connection', { p_person: tenant.person, p_channel: 'email', p_action: 'start' })
    if (role === 'client_member') assert.ifError(connection.error)
    else assert.equal(connection.error?.code, '42501')
  }
  await grantOutreachMembership(tenant.user.id, tenant.client.id, 'operator')
  assert.ifError((await tenant.supabase.rpc('create_outreach_person', { p_client_id: tenant.client.id, p_name: 'Allowed', p_email: 'allowed@example.test' })).error)
  assert.equal((await outsider.supabase.rpc('list_outreach_people', { p_client: tenant.client.id })).error?.code, '42501')
  assert.equal((await outsider.supabase.rpc('prepare_outreach_connection', { p_person: tenant.person, p_channel: 'email', p_action: 'start' })).error?.code, '42501')
})
test('Google API flow is idempotent, persists a consumed result, and does not enable sending', async t => {
  const tenant = await setup(t); let initCalls = 0; let statusCalls = 0
  const handlers = createOnboardingHandlers(config(async (url) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/workspaces/current')) return Response.json({ id: tenant.workspace })
    if (path.endsWith('/oauth/google/init')) { initCalls++; return Response.json({ session_id: randomUUID(), auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=test', expires_at: new Date(Date.now()+600000).toISOString() }) }
    if (path.includes('/oauth/session/status/')) { statusCalls++; return Response.json({ status: 'success', email: tenant.user.email, account_id: tenant.user.email }) }
    if (path.includes('/accounts/')) return Response.json({ email: tenant.user.email, organization: tenant.workspace, status: 1, setup_pending: false })
    throw new Error('Unexpected provider path')
  }))
  const start = { action: 'start', personId: tenant.person, channel: 'email' }
  const responses = await Promise.all([handlers.connection(await request(tenant.supabase, 'connections', start)), handlers.connection(await request(tenant.supabase, 'connections', start))])
  for (const response of responses) assert.equal(response.status, 200, await response.clone().text())
  assert.equal(initCalls, 1)
  const saved = await admin.from('outreach_connections').select('id').eq('person_id', tenant.person).single(); assert.ifError(saved.error)
  await admin.from('outreach_connections').update({ next_poll_at: new Date(0).toISOString() }).eq('id', saved.data!.id)
  const poll = { ...start, action: 'poll' }
  const completed = await handlers.connection(await request(tenant.supabase, 'connections', poll)); assert.equal(completed.status, 200, await completed.clone().text())
  assert.equal((await completed.json()).state, 'connected')
  const repeated = await handlers.connection(await request(tenant.supabase, 'connections', poll)); assert.equal(repeated.status, 200)
  assert.equal(statusCalls, 1)
  const people = peopleSchema.parse((await tenant.supabase.rpc('list_outreach_people', { p_client: tenant.client.id })).data)
  assert.equal(people[0].connections[0].state, 'connected')
  assert.equal((await admin.from('outreach_reply_senders').select('id').eq('client_id', tenant.client.id)).data!.length, 0)
  const body = await repeated.text(); for (const secret of ['synthetic', 'credential', 'remote_session', 'workspace']) assert.ok(!body.includes(secret))
})
test('Microsoft API flow returns a Microsoft sign-in link and connects the expected mailbox', async t => {
  const tenant = await setup(t); const paths: string[] = []
  const authUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=synthetic&state=test'
  const handlers = createOnboardingHandlers(config(async (url) => {
    const path = new URL(String(url)).pathname; paths.push(path)
    if (path.endsWith('/workspaces/current')) return Response.json({ id: tenant.workspace })
    if (path.endsWith('/oauth/microsoft/init')) return Response.json({ session_id: randomUUID(), auth_url: authUrl, expires_at: new Date(Date.now()+600000).toISOString() })
    if (path.includes('/oauth/session/status/')) return Response.json({ status: 'success', email: tenant.user.email, account_id: tenant.user.email })
    if (path.includes('/accounts/')) return Response.json({ email: tenant.user.email, organization: tenant.workspace, status: 1, setup_pending: false })
    throw new Error('Unexpected provider path')
  }))
  const start = { action: 'start', personId: tenant.person, channel: 'email', provider: 'microsoft' }
  const started = await handlers.connection(await request(tenant.supabase, 'connections', start)); assert.equal(started.status, 200, await started.clone().text())
  assert.deepEqual(await started.json().then(body => [body.state, body.authUrl]), ['pending', authUrl])
  assert.ok(paths.some(path => path.endsWith('/oauth/microsoft/init'))); assert.ok(!paths.some(path => path.endsWith('/oauth/google/init')))
  const saved = await admin.from('outreach_connections').select('id').eq('person_id', tenant.person).single(); assert.ifError(saved.error)
  await admin.from('outreach_connections').update({ next_poll_at: new Date(0).toISOString() }).eq('id', saved.data!.id)
  const completed = await handlers.connection(await request(tenant.supabase, 'connections', { action: 'poll', personId: tenant.person, channel: 'email' }))
  assert.equal(completed.status, 200, await completed.clone().text()); assert.equal((await completed.json()).state, 'connected')
})
test('stored sign-in links must come from Google or Microsoft', async t => {
  const tenant = await setup(t)
  const started = await tenant.supabase.rpc('prepare_outreach_connection', { p_person: tenant.person, p_channel: 'email', p_action: 'start' }); assert.ifError(started.error)
  const claim = started.data![0]
  const rejected = await admin.rpc('finish_outreach_connection', { p_id: claim.connection_id, p_lease: claim.claim_token, p_state: 'pending', p_auth_url: 'https://login.microsoftonline.com.evil.test/common/oauth2/v2.0/authorize?state=x' })
  assert.equal(rejected.error?.code, '22023')
  const accepted = await admin.rpc('finish_outreach_connection', { p_id: claim.connection_id, p_lease: claim.claim_token, p_state: 'pending', p_auth_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=x' })
  assert.ifError(accepted.error); assert.equal(accepted.data, true)
})
test('connection leases fence concurrent consumption, revoked authority and lost responses', async t => {
  const tenant = await setup(t)
  const begin = { p_person: tenant.person, p_channel: 'email', p_action: 'start' }
  const started = await tenant.supabase.rpc('prepare_outreach_connection', begin); assert.ifError(started.error)
  const claim = started.data![0]
  assert.equal((await tenant.supabase.rpc('prepare_outreach_connection', begin)).data![0].claim_token, null)
  await admin.from('outreach_memberships').update({ state: 'suspended' }).eq('user_id', tenant.user.id).eq('client_id', tenant.client.id)
  const finished = await admin.rpc('finish_outreach_connection', { p_id: claim.connection_id, p_lease: claim.claim_token, p_state: 'connected', p_remote_account: tenant.user.email })
  assert.equal(finished.data, false)
  await grantOutreachMembership(tenant.user.id, tenant.client.id)
  // A separate attempt models a process dying after the remote service accepted a request.
  await admin.from('outreach_connections').update({ lease_until: new Date(0).toISOString() }).eq('id', claim.connection_id)
  await tenant.supabase.rpc('prepare_outreach_connection', begin)
  const rows = peopleSchema.parse((await tenant.supabase.rpc('list_outreach_people', { p_client: tenant.client.id })).data)
  assert.equal(rows[0].connections[0].state, 'needs_review')
  assert.equal(rows[0].connections[0].canContinue, false)
})
test('email identity reservation prevents cross-client adoption in a shared workspace', async t => {
  const tenant = await setup(t); const other = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(other.user.id, other.client.id)
  assert.ifError((await admin.from('outreach_account_workspaces').insert({ client_id: other.client.id, credential_ref: 'OUTREACH_INSTANTLY_TEST', remote_workspace_id: tenant.workspace, enabled: true })).error)
  const second = await other.supabase.rpc('create_outreach_person', { p_client_id: other.client.id, p_name: 'Same identity', p_email: tenant.user.email }); assert.ifError(second.error)
  assert.ifError((await tenant.supabase.rpc('prepare_outreach_connection', { p_person: tenant.person, p_channel: 'email', p_action: 'start' })).error)
  assert.equal((await other.supabase.rpc('prepare_outreach_connection', { p_person: second.data!, p_channel: 'email', p_action: 'start' })).error?.code, '22023')
})
test('client invitation provisions a new login, enforces email, and never issues an existing user login token', async t => {
  const owner = await createTenant(t, { features: ['outreach_app'] }); await grantOutreachOwner(owner.user.id)
  const handlers = createOnboardingHandlers(config())
  const email = `new-${randomUUID()}@example.test`
  const response = await handlers.invite(await request(owner.supabase, 'invitations', { clientId: owner.client.id, email }))
  assert.equal(response.status, 200, await response.clone().text())
  const body = await response.json(); assert.ok(body.loginToken)
  const client = anonClient()
  const verified = await client.auth.verifyOtp({ token_hash: body.loginToken, type: 'invite' }); assert.ifError(verified.error)
  const userId = verified.data.user!.id
  t.after(async () => { await admin.from('clients').delete().eq('id', owner.client.id); await admin.auth.admin.deleteUser(userId) })
  assert.equal((await owner.supabase.rpc('accept_outreach_invitation', { p_token: body.token })).error?.code, '42501')
  assert.ifError((await client.auth.updateUser({ password: `Password-${randomUUID()}` })).error)
  assert.ifError((await client.rpc('accept_outreach_invitation', { p_token: body.token })).error)
  assert.equal(portalContextSchema.parse((await client.rpc('outreach_portal_context')).data).workspaces[0].role, 'client_admin')
  const existing = await createAdmin(t)
  const again = await handlers.invite(await request(owner.supabase, 'invitations', { clientId: owner.client.id, email: existing.user.email }))
  assert.equal(again.status, 200); assert.equal((await again.json()).loginToken, null)
  assert.equal((await handlers.invite(await request(client, 'invitations', { clientId: owner.client.id, email: 'no@example.test' }))).status, 403)
})

test('LinkedIn PIN flow completes with a disabled sender binding and no credentials in storage', async t => {
  const tenant = await setup(t)
  assert.ifError((await admin.from('outreach_reply_workspaces').insert({ client_id: tenant.client.id, channel: 'linkedin', credential_ref: 'OUTREACH_HEYREACH_TEST', remote_workspace_id: randomUUID(), enabled: true })).error)
  let connected = false; let pinCalls = 0; let connectCalls = 0
  const handlers = createOnboardingHandlers(config(async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/Connect')) { connectCalls++; return Response.json({ linkedInAccountId: '123' }) }
    if (path.endsWith('/SubmitPin')) { assert.equal(JSON.parse(String(init?.body)).accountId, 123); pinCalls++; connected = true; return new Response(null, { status: 204 }) }
    if (path.endsWith('/GetAccountStatus/123')) return Response.json({ accountId: 123, status: connected ? 'Connected' : 'Connecting', profile: { profileUrl: 'https://www.linkedin.com/in/synthetic-person' } })
    throw new Error('Unexpected provider path')
  }))
  const started = await handlers.connection(await request(tenant.supabase, 'connections', { action: 'start', personId: tenant.person, channel: 'linkedin', email: tenant.user.email, password: 'synthetic-password-never-stored', country: 'US' }))
  assert.equal(started.status, 200, await started.clone().text())
  async function release() { assert.ifError((await admin.from('outreach_connections').update({ next_poll_at: new Date(0).toISOString() }).eq('person_id', tenant.person)).error) }
  await release()
  const pin = await handlers.connection(await request(tenant.supabase, 'connections', { action: 'pin', personId: tenant.person, channel: 'linkedin', pin: '123456' }))
  assert.equal(pin.status, 200, await pin.clone().text()); assert.equal(pinCalls, 1)
  await release()
  const poll = await handlers.connection(await request(tenant.supabase, 'connections', { action: 'poll', personId: tenant.person, channel: 'linkedin' }))
  assert.equal(poll.status, 200, await poll.clone().text()); assert.equal((await poll.json()).state, 'connected'); assert.equal(connectCalls, 1)
  const sender = await admin.from('outreach_reply_senders').select('enabled').eq('client_id', tenant.client.id).single()
  assert.ifError(sender.error); assert.equal(sender.data!.enabled, false)
  const storage = JSON.stringify((await admin.from('outreach_connections').select('*').eq('person_id', tenant.person)).data)
  assert.ok(!storage.includes('synthetic-password')); assert.ok(!storage.includes('123456'))
})

test('integration binding requires owner and authenticated API never exposes configured identifiers', async t => {
  const tenant = await setup(t)
  let checks = 0
  const handlers = createOnboardingHandlers({ ...config(async () => { checks++; return Response.json({ id: tenant.workspace }) }),
    workspaces: [{ id: 'managed-mail', label: 'Managed email', channel: 'email', workspaceId: tenant.workspace, credentialRef: 'OUTREACH_INSTANTLY_TEST' }] })
  const body = { clientId: tenant.client.id, optionId: 'managed-mail' }
  assert.equal((await handlers.bindIntegration(await request(tenant.supabase, 'integrations', body))).status, 403); assert.equal(checks, 0)
  assert.equal((await handlers.bindIntegration(new Request('http://localhost/api/onboarding/integrations', { method: 'POST' }))).status, 401)
  await grantOutreachOwner(tenant.user.id)
  assert.equal((await handlers.bindIntegration(await request(tenant.supabase, 'integrations', body))).status, 200); assert.equal(checks, 1)
  const listed = await handlers.integrations(await request(tenant.supabase, `integrations?clientId=${tenant.client.id}`))
  assert.equal(listed.status, 200)
  const text = await listed.text(); for (const secret of [tenant.workspace, 'OUTREACH_INSTANTLY_TEST', 'synthetic']) assert.ok(!text.includes(secret))
})

async function uncertainEmail(t: Parameters<typeof createTenant>[0]) {
  const tenant = await setup(t)
  const start = await tenant.supabase.rpc('prepare_outreach_connection', { p_person: tenant.person, p_channel: 'email', p_action: 'start' }); assert.ifError(start.error)
  const id = start.data![0].connection_id
  assert.equal((await admin.rpc('finish_outreach_connection', { p_id: id, p_lease: start.data![0].claim_token!, p_state: 'uncertain' })).data, true)
  assert.ifError((await admin.from('outreach_connections').update({ next_poll_at: null }).eq('id', id)).error)
  return { ...tenant, id }
}

test('mailbox review confirms expired uncertain attempts without replaying OAuth and survives refresh', async t => {
  const tenant = await uncertainEmail(t)
  assert.ifError((await admin.from('outreach_connections').update({ expires_at: new Date(Date.now()-1000).toISOString() }).eq('id', tenant.id)).error)
  const paths: string[] = []
  const handlers = createOnboardingHandlers(config(async (url, init) => {
    assert.equal(init?.method, 'GET'); const path = new URL(String(url)).pathname; paths.push(path)
    if (path.endsWith('/workspaces/current')) return Response.json({ id: tenant.workspace })
    if (path.includes('/accounts/')) return Response.json({ email: tenant.user.email, organization: tenant.workspace, status: 1, setup_pending: false })
    throw new Error('OAuth must never be replayed')
  }))
  const response = await handlers.connection(await request(tenant.supabase, 'connections', { action: 'review', personId: tenant.person, channel: 'email' }))
  assert.equal(response.status, 200)
  const result = await response.json(); assert.equal(result.state, 'connected'); assert.equal(result.reviewStatus, 'connected'); assert.equal(result.authUrl, null)
  assert.equal(paths.length, 2)
  assert.equal(peopleSchema.parse((await tenant.supabase.rpc('list_outreach_people', { p_client: tenant.client.id })).data).find(p=>p.id===tenant.person)!.connections[0].state, 'connected')
  assert.equal((await admin.from('outreach_reply_senders').select('id').eq('client_id', tenant.client.id)).data!.length, 0)
})

test('review separates absence after expiry from absence during consent and unavailable evidence', async t => {
  const tenant = await uncertainEmail(t)
  let accountStatus = 404
  const handlers = createOnboardingHandlers(config(async url => new URL(String(url)).pathname.endsWith('/workspaces/current')
    ? Response.json({ id: tenant.workspace }) : Response.json({}, { status: accountStatus })))
  async function review() {
    assert.ifError((await admin.from('outreach_connections').update({ next_poll_at: null }).eq('id', tenant.id)).error)
    const response = await handlers.connection(await request(tenant.supabase, 'connections', { action: 'review', personId: tenant.person, channel: 'email' })); assert.equal(response.status, 200); return response.json()
  }
  const waiting = await review(); assert.equal(waiting.state, 'uncertain'); assert.equal(waiting.reviewStatus, 'waiting')
  assert.ifError((await admin.from('outreach_connections').update({ expires_at: new Date(Date.now()-1000).toISOString() }).eq('id', tenant.id)).error)
  accountStatus = 503
  const unavailable = await review(); assert.equal(unavailable.state, 'uncertain'); assert.equal(unavailable.reviewStatus, 'unavailable')
  accountStatus = 404
  const missing = await review(); assert.equal(missing.state, 'expired'); assert.equal(missing.reviewStatus, 'missing')
  assert.ifError((await admin.from('outreach_connections').update({ created_at: new Date(Date.now()-31000).toISOString() }).eq('id', tenant.id)).error)
  const restart = await tenant.supabase.rpc('prepare_outreach_connection', { p_person: tenant.person, p_channel: 'email', p_action: 'start' }); assert.ifError(restart.error); assert.ok(restart.data![0].claim_token)
})

test('rejected email initialization can be reviewed and retried without a consent wait', async t => {
  const tenant = await setup(t); let initCalls = 0; let lookupStatus = 503
  const handlers = createOnboardingHandlers(config(async (url) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/workspaces/current')) return Response.json({ id: tenant.workspace })
    if (path.endsWith('/oauth/microsoft/init')) {
      initCalls++
      return initCalls === 1 ? Response.json({ message: 'Invalid scope. Required: accounts:create. Found: accounts:read' }, { status: 401 })
        : Response.json({ session_id: randomUUID(), auth_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=test', expires_at: new Date(Date.now()+600000).toISOString() })
    }
    if (path.includes('/accounts/')) return Response.json({}, { status: lookupStatus })
    throw new Error('Review must not poll or replay OAuth')
  }))
  const start = { action: 'start', personId: tenant.person, channel: 'email', provider: 'microsoft' }
  const rejected = await handlers.connection(await request(tenant.supabase, 'connections', start))
  assert.equal(rejected.status, 200)
  const failure = await rejected.json(); assert.equal(failure.state, 'failed'); assert.equal(failure.failureCode, 'account_create_required')
  assert.ok(Date.parse(failure.expiresAt) > Date.now())
  async function review() {
    assert.ifError((await admin.from('outreach_connections').update({ next_poll_at: null }).eq('id', failure.connectionId)).error)
    const response = await handlers.connection(await request(tenant.supabase, 'connections', { action: 'review', personId: tenant.person, channel: 'email' }))
    assert.equal(response.status, 200); return response.json()
  }
  // A transport failure remains unverified even when the rejected attempt has
  // no consent deadline. Never replace missing proof with a connected badge.
  const unavailable = await review(); assert.equal(unavailable.state, 'uncertain'); assert.equal(unavailable.reviewStatus, 'unavailable')
  assert.ok(Date.parse(unavailable.expiresAt) <= Date.now())
  const blocked = await handlers.connection(await request(tenant.supabase, 'connections', start))
  assert.equal((await blocked.json()).state, 'uncertain'); assert.equal(initCalls, 1)
  lookupStatus = 404
  const missing = await review(); assert.equal(missing.state, 'expired'); assert.equal(missing.reviewStatus, 'missing')
  assert.equal(initCalls, 1)
  assert.ifError((await admin.from('outreach_connections').update({ created_at: new Date(Date.now()-31000).toISOString() }).eq('id', failure.connectionId)).error)
  const retry = await handlers.connection(await request(tenant.supabase, 'connections', start))
  assert.equal(retry.status, 200); assert.equal((await retry.json()).state, 'pending'); assert.equal(initCalls, 2)
})

test('a failed attempt with a recorded sign-in session keeps its original deadline', async t => {
  const tenant = await setup(t)
  const start = await tenant.supabase.rpc('prepare_outreach_connection', { p_person: tenant.person, p_channel: 'email', p_action: 'start' }); assert.ifError(start.error)
  const claim = start.data![0]
  assert.equal((await admin.rpc('finish_outreach_connection', { p_id: claim.connection_id, p_lease: claim.claim_token!, p_state: 'failed', p_remote_session: randomUUID() })).data, true)
  const before = await admin.from('outreach_connections').select('expires_at').eq('id', claim.connection_id).single(); assert.ifError(before.error)
  const handlers = createOnboardingHandlers(config(async url => new URL(String(url)).pathname.endsWith('/workspaces/current')
    ? Response.json({ id: tenant.workspace }) : Response.json({}, { status: 404 })))
  for (let i = 0; i < 2; i++) {
    assert.ifError((await admin.from('outreach_connections').update({ next_poll_at: null }).eq('id', claim.connection_id)).error)
    const response = await handlers.connection(await request(tenant.supabase, 'connections', { action: 'review', personId: tenant.person, channel: 'email' }))
    assert.equal(response.status, 200)
    const waiting = await response.json(); assert.equal(waiting.state, 'uncertain'); assert.equal(waiting.reviewStatus, 'waiting'); assert.equal(waiting.expiresAt, before.data!.expires_at)
  }
})

test('review enforces self and tenant permissions, fences concurrent/revoked/changed-workspace completions', async t => {
  const tenant = await uncertainEmail(t), owner = await createAdmin(t), other = await createAdmin(t)
  await grantOutreachOwner(owner.user.id)
  const args = { p_person: tenant.person }
  for (const session of [owner.supabase, other.supabase, anonClient()]) assert.equal((await session.rpc('prepare_outreach_email_review', args)).error?.code, '42501')
  assert.equal((await tenant.supabase.rpc('read_outreach_email_review', { p_id: tenant.id, p_lease: randomUUID() })).error?.code, '42501')
  assert.equal((await tenant.supabase.rpc('finish_outreach_email_review', { p_id: tenant.id, p_lease: randomUUID(), p_outcome: 'connected' })).error?.code, '42501')
  const claims = await Promise.all([tenant.supabase.rpc('prepare_outreach_email_review', args), tenant.supabase.rpc('prepare_outreach_email_review', args)])
  for (const claim of claims) assert.ifError(claim.error)
  const tokens = claims.flatMap(c=>c.data!).filter(c=>c.claim_token); assert.equal(tokens.length, 1)
  const lease = tokens[0].claim_token!
  assert.ok((await admin.rpc('read_outreach_email_review', { p_id: tenant.id, p_lease: lease })).data)
  assert.equal((await admin.rpc('finish_outreach_email_review', { p_id: tenant.id, p_lease: randomUUID(), p_outcome: 'connected' })).data, false)
  assert.ifError((await admin.from('outreach_account_workspaces').update({ version: 2 }).eq('client_id', tenant.client.id)).error)
  assert.equal((await admin.rpc('finish_outreach_email_review', { p_id: tenant.id, p_lease: lease, p_outcome: 'connected' })).data, false)
  assert.ifError((await admin.from('outreach_connections').update({ lease_until: new Date(Date.now()-1000).toISOString(), next_poll_at: null }).eq('id', tenant.id)).error)
  const renewed = await tenant.supabase.rpc('prepare_outreach_email_review', args); assert.ifError(renewed.error)
  await grantOutreachMembership(tenant.user.id, tenant.client.id, 'client_viewer')
  assert.equal((await tenant.supabase.rpc('prepare_outreach_email_review', args)).error?.code, '42501')
  assert.equal((await admin.rpc('finish_outreach_email_review', { p_id: tenant.id, p_lease: renewed.data![0].claim_token!, p_outcome: 'connected' })).data, false)
})

test('Microsoft pending sign-in is resumed without a second initialization or provider switch', async t => {
  const tenant = await setup(t); let calls = 0
  const url = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=synthetic'
  const handlers = createOnboardingHandlers(config(async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/workspaces/current')) return Response.json({ id: tenant.workspace })
    if (path.endsWith('/oauth/microsoft/init')) { calls++; return Response.json({ session_id: randomUUID(), auth_url: url, expires_at: new Date(Date.now()+600000).toISOString() }) }
    throw new Error('Must not start another provider or consume status early')
  }))
  const start = { action: 'start', personId: tenant.person, channel: 'email', provider: 'microsoft' }
  const first = await handlers.connection(await request(tenant.supabase, 'connections', start)); assert.equal(first.status, 200)
  const repeated = await handlers.connection(await request(tenant.supabase, 'connections', { ...start, provider: 'google' })); assert.equal(repeated.status, 200)
  assert.equal((await repeated.json()).authUrl, url); assert.equal(calls, 1)
  const resumed = await handlers.connection(await request(tenant.supabase, 'connections', { action: 'poll', channel: 'email', personId: tenant.person }))
  assert.equal(resumed.status, 200); assert.equal((await resumed.json()).authUrl, url); assert.equal(calls, 1)
})
test('Microsoft selection preserves tenant, role and input authorization before provider calls', async t => {
  const tenant = await setup(t); const outsider = await createTenant(t, { features: ['outreach_app'] }); let calls = 0
  await grantOutreachMembership(outsider.user.id, outsider.client.id)
  const handlers = createOnboardingHandlers(config(async () => { calls++; throw new Error('No provider calls allowed') }))
  const start = { action: 'start', personId: tenant.person, channel: 'email', provider: 'microsoft' }
  assert.equal((await handlers.connection(await request(outsider.supabase, 'connections', start))).status, 403)
  await grantOutreachMembership(tenant.user.id, tenant.client.id, 'client_viewer')
  assert.equal((await handlers.connection(await request(tenant.supabase, 'connections', start))).status, 403)
  assert.equal((await handlers.connection(await request(tenant.supabase, 'connections', { ...start, provider: 'other' }))).status, 400)
  assert.equal((await handlers.connection(await request(tenant.supabase, 'connections', { ...start, action: 'poll' }))).status, 400)
  assert.equal(calls, 0)
})
