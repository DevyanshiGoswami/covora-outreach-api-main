import assert from 'node:assert/strict'
import test from 'node:test'
import { connectAccount, reviewEmailAccount, checkConnectionWorkspace, verifyConnectionWorkspace, googleAuthorizationUrl, type ConnectionContext } from '../../src/lib/onboarding-provider'

const workspace = '00000000-0000-4000-8000-000000000001'
const sessionId = '00000000-0000-4000-8000-000000000002'
const context: ConnectionContext = { channel: 'email', email: 'person@example.test', workspace, credential: 'OUTREACH_INSTANTLY_TEST', remoteSession: sessionId, remoteAccount: null }
function transport(responses: (unknown | Response)[], check?: (url: string, init?: RequestInit) => void): typeof fetch {
  return async (url, init) => { check?.(String(url), init); assert.ok(responses.length, 'Unexpected provider request'); const response = responses.shift(); return response instanceof Response ? response : Response.json(response) }
}
test('Google initialization only accepts a Google authorization URL and verifies workspace first', async () => {
  const paths: string[] = []
  const result = await connectAccount(context, 'start', { key: 'synthetic', fetch: transport([{ id: workspace }, { session_id: sessionId, auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=test', expires_at: new Date(Date.now()+600000).toISOString() }], (url, init) => {
    paths.push(new URL(url).pathname); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal); assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic')
  }) })
  assert.equal(result.state, 'pending'); assert.equal(result.remoteSession, sessionId)
  assert.deepEqual(paths, ['/api/v2/workspaces/current', '/api/v2/oauth/google/init'])
  for (const url of ['https://accounts.google.com.evil.test/o/oauth2/auth?state=x', 'https://evil.test', 'javascript:alert(1)', 'https://accounts.google.com@evil.test', 'https://accounts.google.com/other?state=x']) assert.throws(() => googleAuthorizationUrl(url))
})
test('wrong workspace prevents OAuth initialization', async () => {
  assert.deepEqual(await connectAccount(context, 'start', { key: 'synthetic', fetch: transport([{ id: sessionId }]) }), { state: 'failed', failureCode: 'workspace_mismatch' })
})
test('Google success is bound to the expected mailbox and account workspace', async () => {
  assert.deepEqual(await connectAccount(context, 'poll', { key: 'synthetic', fetch: transport([{ id: workspace }, { status: 'success', email: context.email, account_id: context.email }, { email: context.email, organization: workspace, status: 1, setup_pending: false }]) }), { state: 'connected', remoteAccount: context.email })
  assert.deepEqual(await connectAccount(context, 'poll', { key: 'synthetic', fetch: transport([{ id: workspace }, { status: 'success', email: 'other@example.test', account_id: 'other@example.test' }]) }), { state: 'failed', failureCode: 'mailbox_mismatch' })
})
test('timeouts and unrecognized consumed OAuth results remain uncertain with no automatic retry', async () => {
  let calls = 0
  const result = await connectAccount(context, 'start', { key: 'synthetic', fetch: async () => { calls++; throw new Error('Do not expose credential diagnostics') } })
  assert.deepEqual(result, { state: 'uncertain', failureCode: 'service_unavailable' }); assert.equal(calls, 1)
  assert.deepEqual(await connectAccount(context, 'poll', { key: 'synthetic', fetch: transport([{ id: workspace }, { status: 'unexpected', password: 'sensitive' }]) }), { state: 'uncertain', failureCode: 'service_unavailable' })
})
test('HeyReach Connect uses scoped transport and never requests personal inbox scraping', async () => {
  const result = await connectAccount({ ...context, channel: 'linkedin' }, 'start', { key: 'synthetic', fetch: transport([{ linkedInAccountId: 123 }], (url, init) => {
    assert.equal(url, 'https://api.heyreach.io/api/public/li_account/Connect')
    assert.equal(new Headers(init?.headers).get('X-API-KEY'), 'synthetic')
    assert.deepEqual(JSON.parse(String(init?.body)), { username: context.email, password: 'fake-password', twoFactorAuthKey: '', proxyCountryCode: 'US', inboxScrapeMode: 'HeyReachOnly' })
  }) }, { password: 'fake-password', country: 'US' })
  assert.deepEqual(result, { state: 'pending', remoteAccount: '123' }); assert.ok(!JSON.stringify(result).includes('fake-password'))
})
test('HeyReach PIN and status are bound to the saved account; unknown intermediate states stay pending', async () => {
  const scope = { ...context, channel: 'linkedin' as const, remoteAccount: '123' }
  assert.deepEqual(await connectAccount(scope, 'pin', { key: 'synthetic', fetch: transport([new Response(null, { status: 204 })], (_url, init) => assert.deepEqual(JSON.parse(String(init?.body)), { accountId: 123, pin: '123456' })) }, { pin: '123456' }), { state: 'pending' })
  assert.deepEqual(await connectAccount(scope, 'poll', { key: 'synthetic', fetch: transport([{ accountId: 123, status: 'AwaitingVerification' }]) }), { state: 'pending' })
  assert.deepEqual(await connectAccount(scope, 'poll', { key: 'synthetic', fetch: transport([{ accountId: 456, status: 'Connected' }]) }), { state: 'failed' })
  assert.deepEqual(await connectAccount(scope, 'poll', { key: 'synthetic', fetch: transport([{ accountId: 123, status: 'Connected', profile: { profileUrl: 'https://www.linkedin.com/in/person' } }]) }), { state: 'connected', remoteAccount: '123', address: 'https://www.linkedin.com/in/person' })
})
test('HeyReach credential check accepts both documented success statuses without requiring JSON', async () => {
  for (const response of [new Response(null, { status: 204 }), new Response(null, { status: 200 }), new Response('API key valid', { status: 200 })]) {
    assert.equal(await checkConnectionWorkspace('linkedin', 'workspace', { key: 'synthetic', fetch: transport([response]) }), true)
  }
})
test('HeyReach credential check rejects errors and unexpected statuses without leaking diagnostics', async (t) => {
  const warning = t.mock.method(console, 'warn', () => {})
  for (const status of [202, 301, 401, 403, 429, 500]) {
    assert.equal(await checkConnectionWorkspace('linkedin', 'workspace', { key: 'synthetic-private-key', fetch: transport([new Response('private provider body', { status })]) }), false)
  }
  assert.equal(await checkConnectionWorkspace('linkedin', 'workspace', { key: 'synthetic-private-key', fetch: async () => { throw new Error('private transport details') } }), false)
  const logs = JSON.stringify(warning.mock.calls.map(call => call.arguments))
  assert.ok(logs.includes('401'))
  for (const secret of ['synthetic-private-key', 'private provider body', 'private transport details']) assert.ok(!logs.includes(secret))
})
test('verification classifies rejected keys, denied access, rate limits and service failures', async (t) => {
  t.mock.method(console, 'warn', () => {})
  for (const [status, code] of [[401, 'key_rejected'], [403, 'provider_access_denied'], [429, 'provider_rate_limited'], [503, 'provider_unavailable'], [202, 'key_verification_failed']] as const) {
    assert.deepEqual(await verifyConnectionWorkspace('linkedin', 'workspace', { key: 'synthetic', fetch: transport([new Response('private error', { status })]) }), { ok: false, code })
  }
})

test('Google permission errors become fixed codes without exposing credentials or service text', async (t) => {
  const log = t.mock.method(console, 'warn', () => {})
  for (const [status, message, code] of [
    [401, 'Invalid scope. Required: accounts:create. Found: accounts:read', 'account_create_required'],
    [403, 'Invalid scope. Required: accounts:read. Found: accounts:create', 'account_read_required'],
    [401, 'secret-token-rejected', 'key_rejected'],
    [403, 'private-error', 'access_denied'],
    [429, 'private-error', 'rate_limited'],
    [503, 'private-error', 'service_unavailable'],
  ] as const) {
    const calls: string[] = []
    const result = await connectAccount(context, 'start', { key: 'secret-key', fetch: transport([{ id: workspace }, Response.json({ message }, { status })], url => calls.push(url)) })
    assert.equal(result.failureCode, code)
    assert.equal(result.state, status === 503 ? 'uncertain' : 'failed')
    assert.equal(calls.length, 2)
    assert.equal(result.authUrl, undefined)
  }
  const logs = JSON.stringify(log.mock.calls.map(call => call.arguments))
  assert.ok(logs.includes('google_start'))
  for (const secret of ['secret-key', 'secret-token-rejected', 'private-error', context.email, workspace]) assert.ok(!logs.includes(secret))
})

test('unreadable OAuth completion is reconciled from the exact active mailbox without replaying consent', async (t) => {
  const log = t.mock.method(console, 'warn', () => {})
  for (const completion of [
    { status: 'success', email: context.email },
    { status: 'success', email: context.email, account_id: sessionId },
    { status: 'unexpected' },
    Response.json({ error: 'private diagnostic' }, { status: 502 }),
    Response.json({ error: 'session no longer available' }, { status: 404 }),
  ]) {
    const paths: string[] = []
    const result = await connectAccount(context, 'poll', { key: 'secret-key', fetch: transport([
      { id: workspace }, completion, { email: context.email, organization: workspace, status: 1, setup_pending: false },
    ], url => paths.push(new URL(url).pathname)) })
    assert.deepEqual(result, { state: 'connected', remoteAccount: context.email })
    assert.deepEqual(paths, ['/api/v2/workspaces/current', `/api/v2/oauth/session/status/${sessionId}`, `/api/v2/accounts/${encodeURIComponent(context.email)}`])
  }
  const logs = JSON.stringify(log.mock.calls.map(call => call.arguments))
  for (const secret of ['secret-key', 'private diagnostic', context.email, workspace, sessionId]) assert.ok(!logs.includes(secret))
})

test('reconciliation preserves review for missing, wrong-workspace, wrong-mailbox, inactive or unready accounts', async (t) => {
  t.mock.method(console, 'warn', () => {})
  for (const account of [
    Response.json({}, { status: 404 }),
    Response.json({}, { status: 503 }),
    { email: context.email, organization: sessionId, status: 1 },
    { email: 'someone-else@example.test', organization: workspace, status: 1 },
    { email: context.email, organization: workspace, status: 2 },
    { email: context.email, organization: workspace, status: 1, setup_pending: true },
    { email: context.email, status: 1 },
  ]) {
    let calls = 0
    assert.deepEqual(await connectAccount(context, 'poll', { key: 'synthetic', fetch: transport([
      { id: workspace }, { status: 'unexpected' }, account,
    ], () => { calls++ }) }), { state: 'uncertain', failureCode: 'service_unavailable' })
    assert.equal(calls, 3)
  }
})

test('explicit OAuth identity mismatch is never reconciled even with incomplete success fields', async () => {
  for (const result of [
    { status: 'success', email: 'other@example.test' },
    { status: 'success', email: 'other@example.test', account_id: sessionId },
    { status: 'success', email: 'other@example.test', account_id: null },
    { status: 'success', email: context.email, account_id: 'other@example.test' },
  ]) {
    let calls = 0
    assert.deepEqual(await connectAccount(context, 'poll', { key: 'synthetic', fetch: transport([{ id: workspace }, result], () => { calls++ }) }),
      { state: 'failed', failureCode: 'mailbox_mismatch' })
    assert.equal(calls, 2)
  }
})

test('known OAuth failures and expired sessions retain their state without account reconciliation', async (t) => {
  t.mock.method(console, 'warn', () => {})
  for (const [response, state] of [[{ status: 'error' }, 'failed'], [{ status: 'expired' }, 'expired'], [{ status: 'pending' }, 'pending'], [Response.json({}, { status: 403 }), 'failed']] as const) {
    let calls = 0
    const result = await connectAccount(context, 'poll', { key: 'synthetic', fetch: transport([{ id: workspace }, response], () => { calls++ }) })
    assert.equal(result.state, state)
    assert.equal(calls, 2)
  }
})

test('explicit review only reads workspace and reserved mailbox; missing differs from service errors', async () => {
  for (const [response, outcome] of [
    [{ email: context.email, organization: workspace, status: 1, setup_pending: false }, 'connected'],
    [Response.json({}, { status: 404 }), 'missing'],
    [Response.json({}, { status: 503 }), 'unavailable'],
    [{ email: 'wrong@example.test', organization: workspace, status: 1 }, 'unavailable'],
    [{ email: context.email, organization: sessionId, status: 1 }, 'unavailable'],
    [{ email: context.email, organization: workspace, status: 1, setup_pending: true }, 'unavailable'],
  ] as const) {
    const paths: string[] = []
    const result = await reviewEmailAccount(context, { key: 'synthetic', fetch: transport([{ id: workspace }, response], (url, init) => {
      assert.equal(init?.method, 'GET'); paths.push(new URL(url).pathname)
    }) })
    assert.equal(result.outcome, outcome)
    assert.deepEqual(paths, ['/api/v2/workspaces/current', `/api/v2/accounts/${encodeURIComponent(context.email)}`])
  }
  assert.equal((await reviewEmailAccount(context, { key: 'synthetic', fetch: transport([Response.json({}, { status: 404 })]) })).outcome, 'unavailable')
  assert.deepEqual(await reviewEmailAccount(context, { key: 'synthetic', fetch: transport([{ id: sessionId }]) }), { outcome: 'unavailable', failureCode: 'workspace_mismatch' })
})
