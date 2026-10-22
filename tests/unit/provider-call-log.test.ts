import assert from 'node:assert/strict'
import test from 'node:test'
import { checkConnectionWorkspace, connectAccount, probeLinkedInAccess, type ConnectionContext } from '../../src/lib/onboarding-provider'
import { normalizeProviderPath, providerRequestId, redactProviderText, type ProviderCallEntry } from '../../src/lib/provider-call-log'

const key = 'synthetic-api-key-0123456789'
const cookies = [{ name: 'li_at' as const, value: 'AQEDsyntheticsessionvalue0123456789abcdef', domain: '.linkedin.com' as const, path: '/' as const },
  { name: 'JSESSIONID' as const, value: '"ajax:1234567890123"', domain: '.linkedin.com' as const, path: '/' as const }]
const linkedin: ConnectionContext = { channel: 'linkedin', email: 'person@example.test', workspace: 'w', credential: 'OUTREACH_HEYREACH_TEST',
  remoteSession: null, remoteAccount: null, expectedProfileUrl: 'https://www.linkedin.com/in/test-person' }
function recorder() { const entries: ProviderCallEntry[] = []; return { entries, log: async (entry: ProviderCallEntry) => { entries.push(entry) } } }

test('provider text keeps the explanation but masks identities and credential-like values', () => {
  const text = redactProviderText(`{"error":"Account Login API is not enabled for this workspace","email":"jo@example.test","apiKey":"${key}","li_at":"${cookies[0].value}","detail":"Bearer abc.def ${cookies[1].value} ${'x'.repeat(40)}"}`)!
  assert.match(text, /Account Login API is not enabled for this workspace/)
  for (const secret of ['jo@example.test', key, cookies[0].value, 'ajax:1234567890123', 'abc.def', 'x'.repeat(40)]) assert.ok(!text.includes(secret), secret)
  assert.ok(redactProviderText('e'.repeat(5000).replace(/e{30}/g, 'word '))!.length <= 401)
  assert.equal(redactProviderText(' \n '), null)
})

test('provider paths replace mailbox addresses and identifiers with placeholders', () => {
  assert.equal(normalizeProviderPath('/accounts/jo%40example.test'), '/accounts/{email}')
  assert.equal(normalizeProviderPath('/oauth/session/status/00000000-0000-4000-8000-000000000002'), '/oauth/session/status/{id}')
  assert.equal(normalizeProviderPath('/li_account/GetAccountStatus/12345?x=1'), '/li_account/GetAccountStatus/{id}')
  assert.equal(normalizeProviderPath('/li_account/ConnectWithCookies'), '/li_account/ConnectWithCookies')
})

test('the first known request ID header is captured', () => {
  assert.equal(providerRequestId(new Headers({ 'x-request-id': 'req-1', 'cf-ray': 'ray-1' })), 'x-request-id: req-1')
  assert.equal(providerRequestId(new Headers({ 'cf-ray': 'ray-1' })), 'cf-ray: ray-1')
  assert.equal(providerRequestId(new Headers()), null)
})

test('a rejected cookie connection records status, request ID and masked reason without changing the outcome', async () => {
  const { entries, log } = recorder()
  const result = await connectAccount(linkedin, 'start', { key, log, fetch: async () => new Response(
    JSON.stringify({ error: { message: 'Account Login API is not enabled for this workspace' }, echo: cookies[0].value }),
    { status: 403, headers: { 'x-request-id': 'hr-42', 'content-type': 'application/json' } }) }, { cookies, country: 'US', userAgent: 'Synthetic Chrome' })
  assert.equal(result.state, 'failed')
  assert.equal(entries.length, 1)
  const [entry] = entries
  assert.deepEqual({ ...entry, durationMs: 0 }, { channel: 'linkedin', method: 'POST', operation: '/li_account/ConnectWithCookies', status: 403, outcome: 'http_error',
    durationMs: 0, requestId: 'x-request-id: hr-42', errorExcerpt: entry.errorExcerpt })
  assert.match(entry.errorExcerpt!, /Account Login API is not enabled/)
  const logged = JSON.stringify(entries)
  for (const secret of [key, cookies[0].value, 'ajax:1234567890123', 'person@example.test', 'Synthetic Chrome']) assert.ok(!logged.includes(secret), secret)
})

test('anything the request sent is scrubbed from the log even when it is short', async () => {
  const { entries, log } = recorder()
  const shortKey = 'k3y-123'
  await connectAccount(linkedin, 'start', { key: shortKey, log, fetch: async () => new Response(
    `rejected key ${shortKey} for agent Synthetic Chrome with session ${cookies[1].value} in country us`, { status: 400 }) }, { cookies, country: 'US', userAgent: 'Synthetic Chrome' })
  const logged = JSON.stringify(entries)
  for (const secret of [shortKey, 'Synthetic Chrome', 'ajax:1234567890123']) assert.ok(!logged.includes(secret), secret)
  assert.match(entries[0].errorExcerpt!, /^rejected key \[redacted\] for agent \[redacted\]/)
})

test('successful calls are logged without an excerpt; failed transport is logged and still rejected', async () => {
  const ok = recorder()
  assert.equal(await checkConnectionWorkspace('linkedin', 'w', { key, log: ok.log, fetch: async () => new Response(null, { status: 204 }) }), true)
  assert.deepEqual(ok.entries.map(e => [e.operation, e.status, e.outcome, e.errorExcerpt]), [['/auth/CheckApiKey', 204, 'ok', null]])
  const down = recorder()
  const result = await connectAccount(linkedin, 'start', { key, log: down.log, fetch: async () => { throw new TypeError('fetch failed') } }, { cookies, country: 'US', userAgent: 'Synthetic Chrome' })
  assert.equal(result.state, 'uncertain')
  assert.deepEqual(down.entries.map(e => [e.status, e.outcome]), [[null, 'network_error']])
})

test('a failing logger never changes a provider outcome', async () => {
  const result = await connectAccount(linkedin, 'start', { key, log: async () => { throw new Error('log store down') },
    fetch: async () => Response.json({ linkedInAccountId: 321 }) }, { cookies, country: 'US', userAgent: 'Synthetic Chrome' })
  assert.deepEqual(result, { state: 'pending', remoteAccount: '321' })
})

test('the access probe only reads: key check, then an Account Login endpoint with a placeholder account', async () => {
  const { entries, log } = recorder()
  const requests: string[] = []
  const result = await probeLinkedInAccess({ key, log, fetch: async (url, init) => {
    requests.push(`${init?.method} ${new URL(String(url)).pathname}`)
    return String(url).endsWith('/auth/CheckApiKey') ? new Response(null, { status: 200 }) : new Response('Forbidden', { status: 403 })
  } })
  assert.deepEqual(result, { key: 200, accountLogin: 403 })
  assert.deepEqual(requests, ['GET /api/public/auth/CheckApiKey', 'GET /api/public/li_account/GetAccountStatus/1'])
  assert.deepEqual(entries.map(e => [e.operation, e.status, e.errorExcerpt]), [['/auth/CheckApiKey', 200, null], ['/li_account/GetAccountStatus/{id}', 403, 'Forbidden']])
})
