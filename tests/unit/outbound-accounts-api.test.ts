import assert from 'node:assert/strict'
import test from 'node:test'
import { createOutboundAccountHandlers } from '../../src/lib/outbound-accounts-api.ts'

const CLIENT = 'a09b915a-b5a6-4aa0-b31f-182172f965ec'
const OTHER = '61b846cd-e80b-410c-ac02-018d321e3953'
const ACCOUNT = 'edb65128-cb8c-4343-938d-3987bd7c049c'
const CHECK = 'afe0783d-cbd3-416d-a3e5-8367bab1c842'
const WORKSPACE = '92b1c88c-a3fa-4ae3-b1ce-7d1e303c6f17'
const JWT = 'verified-user-jwt'
const SERVICE = 'service-fixture-key'
const KEY = 'dedicated-provider-fixture-key'
const REF = 'OUTREACH_INSTANTLY_PILOT'
const BASE = 'http://localhost/api/outbound/accounts'
const user = { id: '58e6395d-dd8e-4d9d-aef1-d556172ab305', aud: 'authenticated', role: 'authenticated', email: 'fixture@example.test', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-10-03T00:00:00Z' }
const row = { id: ACCOUNT, client_id: CLIENT, channel: 'email', email: 'pilot@example.test', display_name: 'Pilot', state: 'unverified', last_checked_at: null, last_attempt_at: null, last_connected_at: null, check_error: false, updated_at: '2026-10-03T00:00:00Z' }
const checkRow = { account_id: ACCOUNT, client_id: CLIENT, email: row.email, remote_workspace_id: WORKSPACE, credential_ref: REF }
type Reply = { path: string; body: unknown; status?: number }
type Call = { request: Request; body: string }
const rpc = (name: string, body: unknown, status = 200): Reply => ({ path: `/rest/v1/rpc/${name}`, body, status })
const authed = (...replies: Reply[]): Reply[] => [{ path: '/auth/v1/user', body: user }, ...replies]
const workspace = { path: '/rest/v1/client_outreach_workspaces', body: { client_id: CLIENT, role: 'client_viewer' } }
const accounts = (body: unknown = [row]): Reply => ({ path: '/rest/v1/client_outreach_accounts', body })
const configRow = (body: unknown = { client_id: CLIENT, enabled: true, credential_ref: REF }): Reply => ({ path: '/rest/v1/outreach_account_workspaces', body })

async function harness(replies: Reply[] = [], options: { credentials?: Record<string, string>; provider?: { body: unknown; status?: number }[]; timeoutMs?: number } = {}) {
  const calls: Call[] = [], providerCalls: Request[] = []
  const handlers = createOutboundAccountHandlers({
    url: 'https://outbound-db.invalid', anonKey: 'public-fixture-key', serviceKey: SERVICE,
    credentials: options.credentials ?? { [REF]: KEY }, timeoutMs: options.timeoutMs,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      calls.push({ request, body: await request.text() })
      const reply = replies.shift()
      assert.ok(reply, 'Unexpected database request')
      assert.equal(new URL(request.url).pathname, reply.path)
      return Response.json(reply.body, { status: reply.status ?? 200 })
    },
    providerFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      providerCalls.push(new Request(input, init))
      const reply = options.provider?.shift()
      assert.ok(reply, 'Unexpected provider request')
      return Response.json(reply.body, { status: reply.status ?? 200 })
    },
  })
  return { handlers, calls, providerCalls, replies }
}
function request(method: string, body?: unknown, query = '') {
  return new Request(`${BASE}${query}`, { method, headers: { authorization: `Bearer ${JWT}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function responseError(response: Response, status: number) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('vary'), 'Authorization')
  const body = await response.json()
  assert.deepEqual(Object.keys(body), ['error'])
  assert.equal(typeof body.error, 'string')
  assert.doesNotMatch(body.error, /fixture|private|credential|scope_mismatch|identity_mismatch|check_unavailable/)
}

test('account routes require a verified bearer and never accept cookies alone', async () => {
  for (const name of ['GET', 'POST', 'verify'] as const) {
    const { handlers, calls } = await harness()
    await responseError(await handlers[name](new Request(BASE, { method: name === 'GET' ? 'GET' : 'POST', headers: { cookie: 'session=only-cookie' } })), 401)
    assert.equal(calls.length, 0)
  }
  const { handlers, calls } = await harness([{ path: '/auth/v1/user', status: 401, body: { message: 'private credential' } }])
  await responseError(await handlers.GET(request('GET', undefined, `?clientId=${CLIENT}`)), 401)
  assert.equal(calls.length, 1)
})

test('GET projects only neutral fields and accesses private config after workspace authorization', async () => {
  const { handlers, calls, providerCalls } = await harness(authed(workspace, accounts([{ ...row, private: KEY, remote_workspace_id: WORKSPACE }]), configRow()))
  const response = await handlers.GET(request('GET', undefined, `?clientId=${CLIENT}`))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { accounts: [row], verificationAvailable: true })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  for (const call of calls.slice(0, 3)) {
    assert.equal(call.request.headers.get('authorization'), `Bearer ${JWT}`)
    assert.equal(call.request.headers.get('apikey'), 'public-fixture-key')
  }
  assert.equal(calls[3].request.headers.get('authorization'), `Bearer ${SERVICE}`)
  assert.equal(new URL(calls[2].request.url).searchParams.get('client_id'), `eq.${CLIENT}`)
  assert.equal(new URL(calls[3].request.url).searchParams.get('client_id'), `eq.${CLIENT}`)
  assert.equal(providerCalls.length, 0)
})

test('inaccessible workspaces never reach service-role config or accounts', async () => {
  const { handlers, calls } = await harness(authed({ ...workspace, body: null }))
  await responseError(await handlers.GET(request('GET', undefined, `?clientId=${CLIENT}`)), 403)
  assert.equal(calls.length, 2)
})

test('GET rejects malformed queries and cross-tenant or malformed rows', async () => {
  for (const query of ['', '?clientId=bad', `?clientId=${CLIENT}&clientId=${CLIENT}`, `?clientId=${CLIENT}&secret=x`]) {
    const { handlers, calls } = await harness(authed())
    await responseError(await handlers.GET(request('GET', undefined, query)), 400)
    assert.equal(calls.length, 1)
  }
  for (const body of [[{ ...row, client_id: OTHER }], [{ ...row, state: 'unknown' }], [{ ...row, last_checked_at: 'bad' }]]) {
    const { handlers } = await harness(authed(workspace, accounts(body)))
    await responseError(await handlers.GET(request('GET', undefined, `?clientId=${CLIENT}`)), 500)
  }
})

test('GET does not silently truncate account lists at the database page boundary', async () => {
  const { handlers, calls } = await harness(authed(workspace, accounts(Array(500).fill(row)), accounts([{ ...row, id: CHECK }]), configRow()))
  const response = await handlers.GET(request('GET', undefined, `?clientId=${CLIENT}`))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).accounts.length, 501)
  assert.equal(new URL(calls[2].request.url).searchParams.get('offset'), '0')
  assert.equal(new URL(calls[3].request.url).searchParams.get('offset'), '500')
})

test('verification availability requires an enabled dedicated credential, never the global key', async () => {
  for (const config of [null, { client_id: CLIENT, credential_ref: REF, enabled: false }, { client_id: CLIENT, credential_ref: 'INSTANTLY_API_KEY', enabled: true }, { client_id: CLIENT, credential_ref: REF, enabled: true }]) {
    const { handlers } = await harness(authed(workspace, accounts(), configRow(config)), { credentials: { INSTANTLY_API_KEY: KEY } })
    const response = await handlers.GET(request('GET', undefined, `?clientId=${CLIENT}`))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).verificationAvailable, false)
  }
})

test('registration normalizes email and keeps credentials and authority out of the command', async () => {
  const { handlers, calls } = await harness(authed(rpc('register_outreach_account', ACCOUNT)))
  const response = await handlers.POST(request('POST', { clientId: CLIENT, email: ' PILOT@EXAMPLE.TEST ', displayName: '😀'.repeat(100) }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { accountId: ACCOUNT })
  assert.deepEqual(JSON.parse(calls[1].body), { p_client_id: CLIENT, p_email: row.email, p_display_name: '😀'.repeat(100) })
  assert.equal(calls[1].request.headers.get('authorization'), `Bearer ${JWT}`)
})

test('registration rejects malformed and extra fields without mutation', async () => {
  const valid = { clientId: CLIENT, email: row.email, displayName: '' }
  for (const body of [null, {}, { ...valid, email: 'invalid' }, { ...valid, clientId: 'bad' }, { ...valid, displayName: '😀'.repeat(101) }, { ...valid, apiKey: KEY }, { ...valid, state: 'connected' }, { ...valid, displayName: null }]) {
    const { handlers, calls } = await harness(authed())
    await responseError(await handlers.POST(request('POST', body)), 400)
    assert.equal(calls.length, 1)
  }
})

test('account mutations require bounded JSON bodies and reject query parameters', async () => {
  for (const name of ['POST', 'verify'] as const) {
    for (const body of ['{invalid', ' '.repeat(8193)]) {
      const { handlers, calls } = await harness(authed())
      await responseError(await handlers[name](new Request(BASE, { method: 'POST', headers: { authorization: `Bearer ${JWT}`, 'content-type': 'application/json', 'content-length': '2' }, body })), 400)
      assert.equal(calls.length, 1)
    }
    const { handlers } = await harness(authed())
    await responseError(await handlers[name](request('POST', { clientId: CLIENT, accountId: ACCOUNT }, '?credential=x')), 400)
  }
})

test('verification follows authorized check ID and never sends the user token or service key to the provider', async () => {
  const { handlers, calls, providerCalls } = await harness(authed(
    rpc('begin_outreach_account_check', CHECK), rpc('read_outreach_account_check', [checkRow]), rpc('finish_outreach_account_check', true),
  ), { provider: [{ body: { id: WORKSPACE } }, { body: { email: row.email, organization: WORKSPACE, status: 2, setup_pending: false } }] })
  const response = await handlers.verify(request('POST', { clientId: CLIENT, accountId: ACCOUNT }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(JSON.parse(calls[1].body), { p_client_id: CLIENT, p_account_id: ACCOUNT })
  assert.equal(calls[1].request.headers.get('authorization'), `Bearer ${JWT}`)
  assert.deepEqual(JSON.parse(calls[2].body), { p_check_id: CHECK })
  assert.deepEqual(JSON.parse(calls[3].body), { p_check_id: CHECK, p_state: 'paused' })
  for (const call of calls.slice(2)) assert.equal(call.request.headers.get('authorization'), `Bearer ${SERVICE}`)
  for (const call of providerCalls) assert.equal(call.headers.get('authorization'), `Bearer ${KEY}`)
})

test('provider failures are persisted as check errors without inventing a new state', async () => {
  for (const [provider, expected] of [
    [[{ body: { id: OTHER } }], 'scope_mismatch'],
    [[{ body: { id: WORKSPACE } }, { body: { ...row, email: 'different@example.test', organization: WORKSPACE, status: 1, setup_pending: false } }], 'identity_mismatch'],
    [[{ status: 500, body: { private: KEY } }], 'check_unavailable'],
  ] as const) {
    const { handlers, calls } = await harness(authed(rpc('begin_outreach_account_check', CHECK), rpc('read_outreach_account_check', [checkRow]), rpc('finish_outreach_account_check', true)), { provider: [...provider] })
    const response = await handlers.verify(request('POST', { clientId: CLIENT, accountId: ACCOUNT }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.deepEqual(JSON.parse(calls[3].body), { p_check_id: CHECK, p_error_code: expected })
  }
})

test('missing or disallowed credentials cannot cause a provider call or global-key fallback', async () => {
  for (const credential_ref of [REF, 'INSTANTLY_API_KEY']) {
    const { handlers, calls, providerCalls } = await harness(authed(rpc('begin_outreach_account_check', CHECK), rpc('read_outreach_account_check', [{ ...checkRow, credential_ref }]), rpc('finish_outreach_account_check', true)), { credentials: { INSTANTLY_API_KEY: KEY } })
    assert.equal((await handlers.verify(request('POST', { clientId: CLIENT, accountId: ACCOUNT }))).status, 200)
    assert.equal(providerCalls.length, 0)
    assert.deepEqual(JSON.parse(calls[3].body), { p_check_id: CHECK, p_error_code: 'check_unavailable' })
  }
})

test('malformed or foreign check context never reaches the provider or finish RPC', async () => {
  for (const body of [[], [{ ...checkRow, client_id: OTHER }], [{ ...checkRow, account_id: CHECK }], [{ ...checkRow, remote_workspace_id: 'invalid' }]]) {
    const { handlers, calls, providerCalls } = await harness(authed(rpc('begin_outreach_account_check', CHECK), rpc('read_outreach_account_check', body)))
    await responseError(await handlers.verify(request('POST', { clientId: CLIENT, accountId: ACCOUNT })), 500)
    assert.equal(providerCalls.length, 0)
    assert.equal(calls.length, 3)
  }
})

test('authority, cooldown, infrastructure and stale finish failures have neutral no-store responses', async () => {
  for (const [code, status] of [['42501', 403], ['22023', 400], ['XX000', 500]] as const) {
    const { handlers, calls, providerCalls } = await harness(authed(rpc('begin_outreach_account_check', { code, message: KEY, details: 'private scope_mismatch' }, 400)))
    await responseError(await handlers.verify(request('POST', { clientId: CLIENT, accountId: ACCOUNT })), status)
    assert.equal(calls.length, 2)
    assert.equal(providerCalls.length, 0)
  }
  const { handlers } = await harness(authed(rpc('begin_outreach_account_check', CHECK), rpc('read_outreach_account_check', [checkRow]), rpc('finish_outreach_account_check', false)), { credentials: {} })
  await responseError(await handlers.verify(request('POST', { clientId: CLIENT, accountId: ACCOUNT })), 403)
})


test('account lists exceeding the safety cap fail rather than returning a truncated success', async () => {
  const pages = Array.from({ length: 10 }, () => accounts(Array(500).fill(row)))
  const { handlers } = await harness(authed(workspace, ...pages, accounts([{ ...row, id: CHECK }]), configRow()))
  await responseError(await handlers.GET(request('GET', undefined, `?clientId=${CLIENT}`)), 500)
})
