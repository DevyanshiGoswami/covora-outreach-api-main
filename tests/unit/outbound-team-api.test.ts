import assert from 'node:assert/strict'
import test from 'node:test'

import { createOutboundTeamHandlers } from '../../src/lib/outbound-team-api.ts'

const CLIENT = 'c5ddfa59-1551-4688-a381-10d94107140f'
const USER = 'f0d5c941-2898-4f66-a7bb-51e68443517e'
const INVITATION = '9d375705-20e1-4c5e-a0af-be175888827f'
const TOKEN = 'a'.repeat(64) // Synthetic test secret, never a live invitation.
const JWT = 'fixture-user-jwt'
const user = { id: USER, aud: 'authenticated', role: 'authenticated', email: 'member@example.test',
  app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-10-03T00:00:00Z' }
const BASE = 'http://localhost/api/outbound'
const member = { client_id: CLIENT, user_id: USER, email: 'member@example.test', role: 'client_viewer', state: 'active', version: 1, is_agency_owner: false }
const invitation = { id: INVITATION, client_id: CLIENT, email: 'future@example.test', role: 'client_member',
  status: 'pending', expires_at: '2026-10-10T00:00:00Z', created_at: '2026-10-03T00:00:00Z' }
type Reply = { path: string; body: unknown; status?: number }
type Call = { url: URL; method: string; headers: Headers; body: string; cache: RequestCache }

function harness(replies: Reply[] = []) {
  const calls: Call[] = []
  const handlers = createOutboundTeamHandlers({
    url: 'https://outbound-db.invalid', anonKey: 'public-fixture-key',
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      calls.push({ url, method: request.method, headers: request.headers, body: await request.text(), cache: request.cache })
      const reply = replies.shift()
      assert.ok(reply, `Unexpected request to ${url.pathname}`)
      assert.equal(url.pathname, reply.path)
      return Response.json(reply.body, { status: reply.status ?? 200 })
    },
  })
  return { handlers, calls, replies }
}
function authed(...replies: Reply[]): Reply[] { return [{ path: '/auth/v1/user', body: user }, ...replies] }
function rpc(name: string, body: unknown, status?: number): Reply { return { path: `/rest/v1/rpc/${name}`, body, status } }
function request(path: string, method = 'GET', body?: unknown) {
  return new Request(BASE + path, { method,
    headers: { authorization: `Bearer ${JWT}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
async function error(response: Response, status: number) {
  assert.equal(response.status, status)
  const body: unknown = await response.json()
  assert.ok(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string')
  assert.deepEqual(Object.keys(body), ['error'])
  assert.doesNotMatch(body.error, /private|token_hash|future@example|fixture-user-jwt/)
  assert.ok(!body.error.includes(TOKEN))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('access-control-allow-origin'), null)
}

test('every team command requires explicit bearer auth and never falls back to cookies', async () => {
  const methods = { listTeam: 'GET', createInvitation: 'POST', revokeInvitation: 'DELETE', changeMembership: 'PATCH', inspectInvitation: 'POST', acceptInvitation: 'POST' } as const
  for (const key of Object.keys(methods) as (keyof typeof methods)[]) {
    for (const authorization of ['', 'Basic invalid', 'Bearer one,two', 'Bearer one two']) {
      const { handlers, calls } = harness()
      await error(await handlers[key](new Request(BASE, {
        method: methods[key], headers: { cookie: 'sb-access-token=cookie-only', authorization },
      })), 401)
      assert.equal(calls.length, 0)
    }
  }
})

test('unverified access tokens cannot reach team or invitation records', async () => {
  const { handlers, calls } = harness([{ path: '/auth/v1/user', status: 401, body: { code: 'bad_jwt', msg: 'private credentials' } }])
  await error(await handlers.inspectInvitation(request('/invitations/inspect', 'POST', { token: TOKEN })), 401)
  assert.equal(calls.length, 1)
})

test('GET checks manager authority and emits only neutral tenant-scoped list DTOs', async () => {
  const { handlers, calls, replies } = harness(authed(
    { path: '/rest/v1/client_outreach_workspaces', body: { client_id: CLIENT, role: 'client_admin' } },
    { path: '/rest/v1/client_outreach_team', body: [{ ...member, password_hash: 'private' }] },
    { path: '/rest/v1/client_outreach_invitations', body: [{ ...invitation, token: TOKEN, token_hash: 'private' }] },
  ))
  const response = await handlers.listTeam(request(`/team?clientId=${CLIENT}`))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { members: [member], invitations: [invitation] })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(replies.length, 0)
  for (const call of calls) {
    assert.equal(call.headers.get('authorization'), `Bearer ${JWT}`)
    assert.equal(call.headers.get('apikey'), 'public-fixture-key')
    assert.equal(call.cache, 'no-store')
    if (call.url.pathname.startsWith('/rest/')) assert.equal(call.url.searchParams.get('client_id'), `eq.${CLIENT}`)
  }
  assert.equal(calls[2].url.searchParams.get('select'), 'client_id,user_id,email,role,state,version,is_agency_owner')
  assert.equal(calls[3].url.searchParams.get('select'), 'id,client_id,email,role,status,expires_at,created_at')
})

test('GET denies absent and non-manager workspaces before empty list reads', async () => {
  for (const row of [null, { client_id: CLIENT, role: 'operator' }, { client_id: CLIENT, role: 'client_member' }, { client_id: CLIENT, role: 'client_viewer' }]) {
    const { handlers, calls } = harness(authed({ path: '/rest/v1/client_outreach_workspaces', body: row }))
    await error(await handlers.listTeam(request(`/team?clientId=${CLIENT}`)), 403)
    assert.equal(calls.length, 2)
  }
})

test('GET reads subsequent bounded pages without silently truncating team or invitation history', async () => {
  const members = Array.from({ length: 501 }, (_, index) => ({ ...member,
    user_id: `f0d5c941-2898-4f66-a7bb-${index.toString(16).padStart(12, '0')}`, email: `member${index}@example.test`,
  }))
  const invitations = Array.from({ length: 501 }, (_, index) => ({ ...invitation,
    id: `9d375705-20e1-4c5e-a0af-${index.toString(16).padStart(12, '0')}`, email: `invited${index}@example.test`,
  }))
  const { handlers, calls } = harness(authed(
    { path: '/rest/v1/client_outreach_workspaces', body: { client_id: CLIENT, role: 'agency_owner' } },
    { path: '/rest/v1/client_outreach_team', body: members.slice(0, 500) },
    { path: '/rest/v1/client_outreach_invitations', body: invitations.slice(0, 500) },
    { path: '/rest/v1/client_outreach_team', body: members.slice(500) },
    { path: '/rest/v1/client_outreach_invitations', body: invitations.slice(500) },
  ))
  const response = await handlers.listTeam(request(`/team?clientId=${CLIENT}`))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { members, invitations })
  for (const path of ['/rest/v1/client_outreach_team', '/rest/v1/client_outreach_invitations']) {
    const pages = calls.filter((call) => call.url.pathname === path)
    assert.deepEqual(pages.map((call) => call.url.searchParams.get('offset')), ['0', '500'])
    assert.ok(pages.every((call) => call.url.searchParams.get('limit') === '500'))
  }
})

test('GET fails closed if a read projection unexpectedly returns another workspace', async () => {
  for (const surface of ['members', 'invitations']) {
    const { handlers } = harness(authed(
      { path: '/rest/v1/client_outreach_workspaces', body: { client_id: CLIENT, role: 'client_admin' } },
      { path: '/rest/v1/client_outreach_team', body: [{ ...member, client_id: surface === 'members' ? USER : CLIENT }] },
      { path: '/rest/v1/client_outreach_invitations', body: [{ ...invitation, client_id: surface === 'invitations' ? USER : CLIENT }] },
    ))
    await error(await handlers.listTeam(request(`/team?clientId=${CLIENT}`)), 500)
  }
})

test('GET rejects malformed, repeated and unknown query fields including invitation secrets', async () => {
  for (const query of ['', '?clientId=invalid', `?clientId=${CLIENT}&clientId=${CLIENT}`, `?clientId=${CLIENT}&token=${TOKEN}`]) {
    const { handlers, calls } = harness(authed())
    await error(await handlers.listTeam(request('/team' + query)), 400)
    assert.equal(calls.length, 1)
  }
})

test('invitation creation normalizes email and returns the one-time secret only in the response body', async () => {
  const { handlers, calls } = harness(authed(rpc('create_outreach_invitation', [{ invitation_id: INVITATION, token: TOKEN, expires_at: invitation.expires_at, token_hash: 'private' }])))
  const response = await handlers.createInvitation(request('/team/invitations', 'POST', { clientId: CLIENT, email: ' Future@Example.test ', role: 'client_member' }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { invitationId: INVITATION, token: TOKEN, expiresAt: invitation.expires_at })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(JSON.parse(calls[1].body), { p_client_id: CLIENT, p_email: 'future@example.test', p_role: 'client_member' })
  assert.equal(calls[1].headers.get('authorization'), `Bearer ${JWT}`)
  assert.ok(!calls[1].url.href.includes(TOKEN))
})

test('invitation creation cannot accept extra authority, expiry or unsupported roles', async () => {
  const valid = { clientId: CLIENT, email: 'future@example.test', role: 'client_member' }
  for (const body of [null, [], {}, { ...valid, clientId: 'invalid' }, { ...valid, email: 'bad' },
    { ...valid, role: 'agency_owner' }, { ...valid, role: 'owner' }, { ...valid, expiresAt: invitation.expires_at },
    { ...valid, token: TOKEN }, { ...valid, invitedBy: USER }]) {
    const { handlers, calls } = harness(authed())
    await error(await handlers.createInvitation(request('/team/invitations', 'POST', body)), 400)
    assert.equal(calls.length, 1)
  }
})

test('invitation revoke uses only the validated invitation ID', async () => {
  const { handlers, calls } = harness(authed(rpc('revoke_outreach_invitation', null)))
  const response = await handlers.revokeInvitation(request('/team/invitations', 'DELETE', { invitationId: INVITATION }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(JSON.parse(calls[1].body), { p_invitation_id: INVITATION })
})

test('member update carries the expected version and allowed role/state without changing identity', async () => {
  const { handlers, calls } = harness(authed(rpc('change_outreach_membership', null)))
  const response = await handlers.changeMembership(request('/team/members', 'PATCH', {
    clientId: CLIENT, userId: USER, role: 'client_viewer', state: 'revoked', expectedVersion: 3,
  }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(JSON.parse(calls[1].body), { p_client_id: CLIENT, p_user_id: USER, p_role: 'client_viewer', p_state: 'revoked', p_expected_version: 3 })
})

test('member update rejects stale-input shapes, unsafe versions and unsupported authority', async () => {
  const valid = { clientId: CLIENT, userId: USER, role: 'client_viewer', state: 'active', expectedVersion: 1 }
  for (const body of [{ ...valid, userId: 'bad' }, { ...valid, role: 'agency_owner' }, { ...valid, state: 'pending' },
    { ...valid, expectedVersion: 0 }, { ...valid, expectedVersion: 1.5 }, { ...valid, expectedVersion: '1' },
    { ...valid, expectedVersion: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, email: 'another@example.test' }]) {
    const { handlers, calls } = harness(authed())
    await error(await handlers.changeMembership(request('/team/members', 'PATCH', body)), 400)
    assert.equal(calls.length, 1)
  }
})

test('inspect normalizes safe invitation metadata and sends the secret only in the RPC body', async () => {
  const { handlers, calls } = harness(authed(rpc('inspect_outreach_invitation', [{
    invitation_id: INVITATION, client_id: CLIENT, client_name: 'Fixture workspace', role: 'client_member',
    expires_at: invitation.expires_at, status: 'pending', password_required: true, email: 'future@example.test', token_hash: 'private', token: TOKEN,
  }])))
  const response = await handlers.inspectInvitation(request('/invitations/inspect', 'POST', { token: TOKEN }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { invitation: { id: INVITATION, clientId: CLIENT, clientName: 'Fixture workspace',
    role: 'client_member', expiresAt: invitation.expires_at, status: 'pending', passwordRequired: true } })
  assert.deepEqual(JSON.parse(calls[1].body), { p_token: TOKEN })
  assert.equal(calls[1].method, 'POST')
  assert.ok(!calls[1].url.href.includes(TOKEN))
})

test('accept asks for a password only when the service refuses an invited identity without one', async () => {
  const refused = harness(authed(rpc('accept_outreach_invitation', { code: '22023', message: 'Set a password first', details: null, hint: null }, 400)))
  const response = await refused.handlers.acceptInvitation(request('/invitations/accept', 'POST', { token: TOKEN }))
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'Create your password before accepting this invitation.', passwordRequired: true })
  const other = harness(authed(rpc('accept_outreach_invitation', { code: '22023', message: 'Invalid invitation', details: null, hint: null }, 400)))
  await error(await other.handlers.acceptInvitation(request('/invitations/accept', 'POST', { token: TOKEN })), 400)
})

test('accept uses current verified identity and returns only the authorized workspace ID', async () => {
  const { handlers, calls } = harness(authed(rpc('accept_outreach_invitation', CLIENT)))
  const response = await handlers.acceptInvitation(request('/invitations/accept', 'POST', { token: TOKEN }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { clientId: CLIENT })
  assert.deepEqual(JSON.parse(calls[1].body), { p_token: TOKEN })
  assert.equal(calls[1].headers.get('authorization'), `Bearer ${JWT}`)
  assert.equal(calls[1].url.search, '')
})

test('inspect and accept reject malformed tokens, actor claims and query-string tokens', async () => {
  for (const name of ['inspectInvitation', 'acceptInvitation'] as const) {
    for (const body of [{}, { token: 'short' }, { token: 'z'.repeat(64) }, { token: TOKEN, email: 'future@example.test' }, { token: TOKEN, userId: USER }]) {
      const { handlers, calls } = harness(authed())
      await error(await handlers[name](request('/invitations/command', 'POST', body)), 400)
      assert.equal(calls.length, 1)
    }
    const { handlers, calls } = harness(authed())
    await error(await handlers[name](request(`/invitations/command?token=${TOKEN}`, 'POST', { token: TOKEN })), 400)
    assert.equal(calls.length, 1)
  }
})

test('all mutation routes enforce JSON and the shared streaming body limit', async () => {
  const methods = { createInvitation: 'POST', revokeInvitation: 'DELETE', changeMembership: 'PATCH', inspectInvitation: 'POST', acceptInvitation: 'POST' } as const
  for (const name of Object.keys(methods) as (keyof typeof methods)[]) {
    for (const body of ['{bad', ' '.repeat(8193)]) {
      const { handlers, calls } = harness(authed())
      await error(await handlers[name](new Request(BASE, { method: methods[name], body,
        headers: { authorization: `Bearer ${JWT}`, 'content-type': 'application/json', 'content-length': '2' },
      })), 400)
      assert.equal(calls.length, 1)
    }
  }
})

test('SQL role, identity, lifecycle and version failures return fixed neutral errors', async () => {
  for (const [code, status] of [['42501', 403], ['22023', 400], ['XX000', 500]] as const) {
    const { handlers } = harness(authed(rpc('accept_outreach_invitation', {
      code, message: `private ${TOKEN}`, details: 'future@example.test token_hash', hint: 'private',
    }, 400)))
    await error(await handlers.acceptInvitation(request('/invitations/accept', 'POST', { token: TOKEN })), status)
  }
})

test('malformed SQL success DTOs do not become a successful or secret-bearing API response', async () => {
  const { handlers } = harness(authed(rpc('create_outreach_invitation', [{ invitation_id: INVITATION, token: 'private', expires_at: invitation.expires_at }])))
  await error(await handlers.createInvitation(request('/team/invitations', 'POST', { clientId: CLIENT, email: 'future@example.test', role: 'client_viewer' })), 500)
})

test('team commands retain the bounded transport deadline without leaking errors', async () => {
  let aborted = false
  const handlers = createOutboundTeamHandlers({
    url: 'https://outbound-db.invalid', anonKey: 'public-fixture-key', timeoutMs: 10,
    fetch: async (_input, init) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json(user)), 100)
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        clearTimeout(timer)
        reject(new Error(`private ${TOKEN}`))
      }, { once: true })
    }),
  })
  await error(await handlers.acceptInvitation(request('/invitations/accept', 'POST', { token: TOKEN })), 500)
  assert.equal(aborted, true)
})
