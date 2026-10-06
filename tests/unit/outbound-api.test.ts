import assert from 'node:assert/strict'
import test from 'node:test'

import { createOutboundSetupHandlers } from '../../src/lib/outbound-api.ts'

const CLIENT_ID = 'a09b915a-b5a6-4aa0-b31f-182172f965ec'
const REQUEST_ID = 'edb65128-cb8c-4343-938d-3987bd7c049c'
const USER_ID = '58e6395d-dd8e-4d9d-aef1-d556172ab305'
const TOKEN = 'verified-user-access-token'
const URL_BASE = 'http://localhost/api/outbound/setup'

const user = {
  id: USER_ID, aud: 'authenticated', role: 'authenticated',
  email: 'fixture@example.test', app_metadata: {}, user_metadata: {},
  identities: [], created_at: '2026-10-03T00:00:00Z',
}

type Reply = { path: string; body: unknown; status?: number }
type Call = { url: URL; method: string; headers: Headers; body: string }

function harness(replies: Reply[] = []) {
  const calls: Call[] = []
  const handlers = createOutboundSetupHandlers({
    url: 'https://outbound-db.invalid',
    anonKey: 'public-anon-key',
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      calls.push({ url, method: request.method, headers: request.headers, body: await request.text() })
      const reply = replies.shift()
      assert.ok(reply, `Unexpected external request: ${url.pathname}`)
      assert.equal(url.pathname, reply.path)
      return new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  return { handlers, calls, replies }
}

function authorizedReplies(...replies: Reply[]): Reply[] {
  return [{ path: '/auth/v1/user', body: user }, ...replies]
}

function request(method: 'GET' | 'POST' | 'PATCH', body?: unknown, headers?: HeadersInit) {
  return new Request(`${URL_BASE}?clientId=${CLIENT_ID}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function expectError(response: Response, status: number) {
  assert.equal(response.status, status)
  const result: unknown = await response.json()
  assert.ok(typeof result === 'object' && result !== null && 'error' in result)
  assert.deepEqual(Object.keys(result), ['error'])
  assert.ok(typeof result.error === 'string')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  return result.error
}

test('every method requires an explicit well-formed bearer and ignores auth cookies', async () => {
  for (const method of ['GET', 'POST', 'PATCH'] as const) {
    for (const authorization of [undefined, 'Basic token', 'Bearer', 'Bearer token another', 'Bearer token,other']) {
      const { handlers, calls } = harness()
      const response = await handlers[method](new Request(URL_BASE, {
        method,
        headers: { cookie: 'sb-access-token=cookie-only', ...(authorization ? { authorization } : {}) },
      }))
      await expectError(response, 401)
      assert.equal(calls.length, 0)
    }
  }
})

test('rejects an unverified bearer before any database request', async () => {
  const { handlers, calls } = harness([
    { path: '/auth/v1/user', status: 401, body: { code: 'bad_jwt', msg: 'private auth details' } },
  ])
  const response = await handlers.GET(request('GET'))
  const error = await expectError(response, 401)
  assert.doesNotMatch(error, /private|bad_jwt/)
  assert.equal(calls.length, 1)
})

test('GET verifies the user and checks the workspace before querying neutral setup fields', async () => {
  const row = {
    id: REQUEST_ID, client_id: CLIENT_ID, channel: 'linkedin', method: 'assisted',
    status: 'requested', note: '', created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:00Z',
  }
  const { handlers, calls, replies } = harness(authorizedReplies(
    { path: '/rest/v1/client_outreach_workspaces', body: { client_id: CLIENT_ID } },
    { path: '/rest/v1/client_outreach_setup_requests', body: [{ ...row, provider_secret: 'never expose' }] },
  ))
  const response = await handlers.GET(request('GET'))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { requests: [row] })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  assert.equal(replies.length, 0)
  for (const call of calls) {
    assert.equal(call.headers.get('authorization'), `Bearer ${TOKEN}`)
    assert.equal(call.headers.get('apikey'), 'public-anon-key')
  }
  assert.equal(calls[1].url.searchParams.get('client_id'), `eq.${CLIENT_ID}`)
  assert.equal(calls[2].url.searchParams.get('client_id'), `eq.${CLIENT_ID}`)
  assert.equal(calls[2].url.searchParams.get('select'), 'id,client_id,channel,method,status,note,created_at,updated_at')
})

test('GET refuses an inaccessible workspace even if its requests would be empty', async () => {
  const { handlers, calls } = harness(authorizedReplies(
    { path: '/rest/v1/client_outreach_workspaces', body: null },
  ))
  await expectError(await handlers.GET(request('GET')), 403)
  assert.equal(calls.length, 2)
})

test('GET rejects missing, malformed, repeated and extra query fields before database reads', async () => {
  for (const query of ['', '?clientId=bad', `?clientId=${CLIENT_ID}&clientId=${CLIENT_ID}`, `?clientId=${CLIENT_ID}&role=owner`]) {
    const { handlers, calls } = harness(authorizedReplies())
    await expectError(await handlers.GET(new Request(URL_BASE + query, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })), 400)
    assert.equal(calls.length, 1)
  }
})

test('POST sends only validated setup parameters through the authenticated RPC', async () => {
  const { handlers, calls } = harness(authorizedReplies(
    { path: '/rest/v1/rpc/request_outreach_setup', body: REQUEST_ID },
  ))
  const response = await handlers.POST(request('POST', { clientId: CLIENT_ID, channel: 'email', method: 'google_workspace' }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { requestId: REQUEST_ID })
  assert.deepEqual(JSON.parse(calls[1].body), {
    p_client_id: CLIENT_ID, p_channel: 'email', p_method: 'google_workspace',
  })
  assert.equal(calls[1].headers.get('authorization'), `Bearer ${TOKEN}`)
})

test('POST rejects unknown fields, invalid IDs and unsupported channel/method combinations', async () => {
  const valid = { clientId: CLIENT_ID, channel: 'email', method: 'assisted' }
  for (const body of [
    null, [], {}, { ...valid, clientId: 'invalid' }, { ...valid, channel: 'sms' },
    { ...valid, method: 'password' }, { ...valid, channel: 'linkedin', method: 'microsoft' },
    { ...valid, requestedBy: USER_ID }, { ...valid, role: 'operator' },
  ]) {
    const { handlers, calls } = harness(authorizedReplies())
    await expectError(await handlers.POST(request('POST', body)), 400)
    assert.equal(calls.length, 1)
  }
})

test('PATCH sends the request identity, permitted status and client-visible note only', async () => {
  const { handlers, calls } = harness(authorizedReplies(
    { path: '/rest/v1/rpc/update_outreach_setup_request', body: null },
  ))
  const response = await handlers.PATCH(request('PATCH', {
    requestId: REQUEST_ID, status: 'needs_action', note: 'Please select a time for setup.',
  }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(JSON.parse(calls[1].body), {
    p_request_id: REQUEST_ID, p_status: 'needs_action', p_note: 'Please select a time for setup.',
  })
  assert.equal(calls[1].headers.get('authorization'), `Bearer ${TOKEN}`)
})

test('PATCH rejects missing, oversized and unexpected fields before a mutation', async () => {
  const valid = { requestId: REQUEST_ID, status: 'in_progress', note: '' }
  for (const body of [
    { ...valid, requestId: 'invalid' }, { ...valid, status: 'connected' }, { ...valid, note: 'a'.repeat(1001) },
    { requestId: REQUEST_ID, status: 'resolved' }, { ...valid, note: null }, { ...valid, clientId: CLIENT_ID },
  ]) {
    const { handlers, calls } = harness(authorizedReplies())
    await expectError(await handlers.PATCH(request('PATCH', body)), 400)
    assert.equal(calls.length, 1)
  }
})

test('note limits count Unicode characters consistently with the database', async () => {
  const note = '🙂'.repeat(1000)
  const { handlers, calls } = harness(authorizedReplies(
    { path: '/rest/v1/rpc/update_outreach_setup_request', body: null },
  ))
  const response = await handlers.PATCH(request('PATCH', { requestId: REQUEST_ID, status: 'in_progress', note }))
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(calls[1].body).p_note, note)
})

test('POST and PATCH reject malformed JSON, non-JSON and oversized request bodies', async () => {
  for (const method of ['POST', 'PATCH'] as const) {
    for (const sample of [
      { body: '{bad', contentType: 'application/json' },
      { body: '{}', contentType: 'text/plain' },
      { body: ' '.repeat(8193), contentType: 'application/json' },
      { body: '{}', contentType: 'application/json', contentLength: '9000' },
    ]) {
      const { handlers, calls } = harness(authorizedReplies())
      const response = await handlers[method](new Request(URL_BASE, {
        method, body: sample.body,
        headers: {
          authorization: `Bearer ${TOKEN}`, 'content-type': sample.contentType,
          ...(sample.contentLength ? { 'content-length': sample.contentLength } : {}),
        },
      }))
      await expectError(response, 400)
      assert.equal(calls.length, 1)
    }
  }
})

test('bounded body reading does not trust a missing or dishonest Content-Length', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(' '.repeat(8193)))
    },
    cancel() { cancelled = true },
  })
  const { handlers, calls } = harness(authorizedReplies())
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST', body, duplex: 'half',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': '2' },
  }
  await expectError(await handlers.POST(new Request(URL_BASE, init)), 400)
  assert.equal(cancelled, true)
  assert.equal(calls.length, 1)
})

test('RPC authorization and validation failures remain neutral and use the contract status', async () => {
  for (const [code, status] of [['42501', 403], ['22023', 400], ['XX000', 500]] as const) {
    for (const method of ['POST', 'PATCH'] as const) {
      const { handlers } = harness(authorizedReplies({
        path: `/rest/v1/rpc/${method === 'POST' ? 'request_outreach_setup' : 'update_outreach_setup_request'}`,
        status: 400,
        body: { code, message: 'private provider diagnostic', details: 'secret', hint: 'raw sql' },
      }))
      const payload = method === 'POST'
        ? { clientId: CLIENT_ID, channel: 'linkedin', method: 'assisted' }
        : { requestId: REQUEST_ID, status: 'resolved', note: '' }
      const error = await expectError(await handlers[method](request(method, payload)), status)
      assert.doesNotMatch(error, /private|provider|diagnostic|secret|sql/)
    }
  }
})

test('database failures and unexpected transport exceptions cannot escape as raw errors', async () => {
  const { handlers } = harness(authorizedReplies({
    path: '/rest/v1/client_outreach_workspaces', status: 500,
    body: { code: 'XX000', message: 'private database error', details: 'credential' },
  }))
  assert.doesNotMatch(await expectError(await handlers.GET(request('GET')), 500), /private|credential|database/)

  const broken = createOutboundSetupHandlers({
    url: 'https://outbound-db.invalid', anonKey: 'public-anon-key',
    fetch: async () => { throw new Error('private transport credentials') },
  })
  assert.doesNotMatch(await expectError(await broken.GET(request('GET')), 500), /private|credentials|transport/)
})

test('a stalled auth request is aborted at the API deadline and returns a neutral error', async () => {
  let aborted = false
  const handlers = createOutboundSetupHandlers({
    url: 'https://outbound-db.invalid', anonKey: 'public-anon-key', timeoutMs: 10,
    fetch: async (_input, init) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json(user)), 100)
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        clearTimeout(timer)
        reject(new Error('private transport timeout details'))
      }, { once: true })
    }),
  })
  const response = await handlers.GET(new Request(URL_BASE, { headers: { authorization: `Bearer ${TOKEN}` } }))
  assert.doesNotMatch(await expectError(response, 500), /private|transport|timeout/)
  assert.equal(aborted, true)
})

test('caller cancellation propagates to outstanding auth work', async () => {
  const controller = new AbortController()
  let aborted = false
  const handlers = createOutboundSetupHandlers({
    url: 'https://outbound-db.invalid', anonKey: 'public-anon-key',
    fetch: async (_input, init) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json(user)), 100)
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        clearTimeout(timer)
        reject(new Error('private cancellation details'))
      }, { once: true })
      controller.abort()
    }),
  })
  const response = await handlers.GET(new Request(URL_BASE, {
    headers: { authorization: `Bearer ${TOKEN}` }, signal: controller.signal,
  }))
  await expectError(response, 500)
  assert.equal(aborted, true)
})
