import assert from 'node:assert/strict'
import test from 'node:test'
import { createOutboundCommentsHandlers } from '../../src/lib/outbound-comments-api.ts'

const CLIENT = '26a2cffb-47f4-4231-9195-b4f772751c6d'
const ID = 'c5ddfa59-1551-4688-a381-10d94107140f'
const OTHER = 'f0d5c941-2898-4f66-a7bb-51e68443517e'
const COMMAND = '9d375705-20e1-4c5e-a0af-be175888827f'
const BASE = 'http://localhost/api/outbound/comments'
const user = { id: OTHER, aud: 'authenticated', role: 'authenticated', email: 'synthetic@example.test',
  app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-10-21T00:00:00Z' }
const summary = { id: ID, clientId: CLIENT, title: 'Change the headline', status: 'open', version: 1,
  createdAt: '2026-10-21T00:00:00+00:00', updatedAt: '2026-10-21T00:00:00+00:00', authorName: 'EPM member', replyCount: 0 }
const list = { clientId: CLIENT, enabled: true, permissions: { canComment: true, canManage: false }, requests: [summary], hasMore: false }
type Reply = { path: string; body: unknown; status?: number }
function harness(...replies: Reply[]) {
  const calls: { url: URL; body: unknown; headers: Headers; cache: string }[] = []
  const handlers = createOutboundCommentsHandlers({ url: 'https://comments-db.invalid', anonKey: 'public-fixture-key',
    fetch: async (input, init) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      const text = await req.text()
      calls.push({ url, body: text ? JSON.parse(text) : null, headers: req.headers, cache: req.cache })
      const reply = replies.shift()
      assert.ok(reply, `Unexpected call: ${url.pathname}`)
      assert.equal(url.pathname, reply.path)
      return Response.json(reply.body, { status: reply.status ?? 200 })
    } })
  return { handlers, calls }
}
const auth = { path: '/auth/v1/user', body: user }
const rpc = (name: string, body: unknown, status?: number) => ({ path: `/rest/v1/rpc/${name}`, body, status })
function request(path = '', method = 'GET', body?: unknown) {
  return new Request(BASE + path, { method, headers: { authorization: 'Bearer synthetic-user-jwt', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function error(response: Response, code: number) {
  assert.equal(response.status, code)
  const body = await response.json()
  assert.deepEqual(Object.keys(body), ['error'])
  assert.equal(typeof body.error, 'string')
  assert.doesNotMatch(body.error, /private|synthetic-user-jwt|secret|SQL/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
}

test('comments verify bearer auth and never use a cookie-only session', async () => {
  const { handlers, calls } = harness()
  const req = new Request(BASE, { headers: { cookie: 'session=synthetic' } })
  await error(await handlers.list(req), 401)
  await error(await handlers.detail(req, ID), 401)
  await error(await handlers.create(req), 401)
  await error(await handlers.reply(req, ID), 401)
  await error(await handlers.updateStatus(req, ID), 401)
  assert.equal(calls.length, 0)
})

test('list binds the authenticated identity and tenant, projects DTO fields, and defaults paging', async () => {
  const { handlers, calls } = harness(auth, rpc('list_outreach_comments', { ...list, private: 'secret', requests: [{ ...summary, author_user_id: OTHER }] }))
  const result = await handlers.list(request(`?clientId=${CLIENT}`))
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), list)
  assert.deepEqual(calls[1].body, { p_client: CLIENT, p_status: 'all', p_offset: 0 })
  for (const call of calls) {
    assert.equal(call.headers.get('authorization'), 'Bearer synthetic-user-jwt')
    assert.equal(call.cache, 'no-store')
  }
})

test('list honors status and offset, and disabled workspaces disclose no stored records', async () => {
  const disabled = { clientId: CLIENT, enabled: false, permissions: { canComment: false, canManage: false }, requests: [], hasMore: false }
  const { handlers, calls } = harness(auth, rpc('list_outreach_comments', disabled))
  assert.deepEqual(await (await handlers.list(request(`?clientId=${CLIENT}&status=resolved&offset=25`))).json(), disabled)
  assert.deepEqual(calls[1].body, { p_client: CLIENT, p_status: 'resolved', p_offset: 25 })
})

test('queries reject duplicates, foreign fields, invalid statuses and unbounded pagination before RPC', async () => {
  for (const suffix of ['', `?clientId=${CLIENT}&clientId=${OTHER}`, `?clientId=${CLIENT}&limit=500`, `?clientId=${CLIENT}&offset=-1`, `?clientId=${CLIENT}&offset=100001`, `?clientId=${CLIENT}&status=deleted`]) {
    const { handlers, calls } = harness(auth)
    await error(await handlers.list(request(suffix)), 400)
    assert.equal(calls.length, 1)
  }
})

test('list rejects inconsistent tenants, disabled payload leakage and oversized database pages', async () => {
  for (const value of [
    { ...list, clientId: OTHER }, { ...list, requests: [{ ...summary, clientId: OTHER }] },
    { ...list, enabled: false }, { ...list, requests: Array(26).fill(summary) },
    { ...list, permissions: { canComment: false, canManage: true } },
  ]) {
    const { handlers } = harness(auth, rpc('list_outreach_comments', value))
    await error(await handlers.list(request(`?clientId=${CLIENT}`)), 500)
  }
})

test('detail checks request and message lineage and strips internal author identities', async () => {
  const detail = { clientId: CLIENT, request: { ...summary, body: '<b>Plain text</b>' }, messages: [{ id: COMMAND, requestId: ID, clientId: CLIENT, body: 'Reply', authorName: 'Covora', createdAt: summary.createdAt }], hasMore: false }
  const { handlers, calls } = harness(auth, rpc('get_outreach_comment', detail))
  assert.deepEqual(await (await handlers.detail(request(`/${ID}?clientId=${CLIENT}&offset=25`), ID)).json(), detail)
  assert.deepEqual(calls[1].body, { p_client: CLIENT, p_request: ID, p_offset: 25 })
  for (const value of [{ ...detail, request: { ...detail.request, id: OTHER } }, { ...detail, messages: [{ ...detail.messages[0], requestId: OTHER }] }]) {
    const check = harness(auth, rpc('get_outreach_comment', value))
    await error(await check.handlers.detail(request(`/${ID}?clientId=${CLIENT}`), ID), 500)
  }
})

test('database-valid astral author names remain readable in lists, request details and replies', async () => {
  const authorName = '😀'.repeat(200)
  const namedSummary = { ...summary, authorName }
  const namedList = { ...list, requests: [namedSummary] }
  const detail = { clientId: CLIENT, request: { ...namedSummary, body: 'Request' },
    messages: [{ id: COMMAND, requestId: ID, clientId: CLIENT, body: 'Reply', authorName, createdAt: summary.createdAt }], hasMore: false }
  const { handlers } = harness(auth, rpc('list_outreach_comments', namedList), auth, rpc('get_outreach_comment', detail))
  const listed = await handlers.list(request(`?clientId=${CLIENT}`))
  assert.equal(listed.status, 200)
  assert.deepEqual(await listed.json(), namedList)
  const loaded = await handlers.detail(request(`/${ID}?clientId=${CLIENT}`), ID)
  assert.equal(loaded.status, 200)
  assert.deepEqual(await loaded.json(), detail)

  const oversizedList = harness(auth, rpc('list_outreach_comments', { ...list, requests: [{ ...summary, authorName: authorName + 'x' }] }))
  await error(await oversizedList.handlers.list(request(`?clientId=${CLIENT}`)), 500)
  const oversizedReply = harness(auth, rpc('get_outreach_comment', { ...detail, messages: [{ ...detail.messages[0], authorName: authorName + 'x' }] }))
  await error(await oversizedReply.handlers.detail(request(`/${ID}?clientId=${CLIENT}`), ID), 500)
})

test('create accepts bounded multibyte text and never accepts a caller-supplied author', async () => {
  const input = { clientId: CLIENT, commandId: COMMAND, title: '  Add a field  ', body: '界'.repeat(5000) }
  const { handlers, calls } = harness(auth, rpc('create_outreach_comment', ID))
  assert.deepEqual(await (await handlers.create(request('', 'POST', input))).json(), { requestId: ID })
  assert.deepEqual(calls[1].body, { p_client: CLIENT, p_command: COMMAND, p_title: 'Add a field', p_body: input.body })
  const denied = harness(auth)
  await error(await denied.handlers.create(request('', 'POST', { ...input, authorName: 'Someone else' })), 400)
  assert.equal(denied.calls.length, 1)
})

test('empty/oversized text, malformed IDs and query-body mixes cannot mutate', async () => {
  const valid = { clientId: CLIENT, commandId: COMMAND, title: 'Change', body: 'Please update' }
  for (const value of [{ ...valid, body: ' ' }, { ...valid, body: 'a'.repeat(5001) }, { ...valid, title: 'x'.repeat(121) }, { ...valid, commandId: 'bad' }]) {
    const { handlers } = harness(auth)
    await error(await handlers.create(request('', 'POST', value)), 400)
  }
  const { handlers } = harness(auth)
  await error(await handlers.create(request('?clientId=' + CLIENT, 'POST', valid)), 400)
  const tooLarge = harness(auth)
  await error(await tooLarge.handlers.create(request('', 'POST', { ...valid, body: 'x'.repeat(40000) })), 400)
})

test('replies bind client/request and command and only return the selected thread', async () => {
  const { handlers, calls } = harness(auth, rpc('reply_outreach_comment', ID))
  assert.deepEqual(await (await handlers.reply(request(`/${ID}/replies`, 'POST', { clientId: CLIENT, commandId: COMMAND, body: 'Follow-up' }), ID)).json(), { requestId: ID })
  assert.deepEqual(calls[1].body, { p_client: CLIENT, p_request: ID, p_command: COMMAND, p_body: 'Follow-up' })
  const inconsistent = harness(auth, rpc('reply_outreach_comment', OTHER))
  await error(await inconsistent.handlers.reply(request('', 'POST', { clientId: CLIENT, commandId: COMMAND, body: 'Reply' }), ID), 500)
})

test('status requires an explicit valid version and only forwards neutral status input', async () => {
  const { handlers, calls } = harness(auth, rpc('set_outreach_comment_status', null))
  assert.deepEqual(await (await handlers.updateStatus(request(`/${ID}`, 'PATCH', { clientId: CLIENT, expectedVersion: 2, status: 'resolved' }), ID)).json(), { ok: true })
  assert.deepEqual(calls[1].body, { p_client: CLIENT, p_request: ID, p_version: 2, p_status: 'resolved' })
  const denied = harness(auth)
  await error(await denied.handlers.updateStatus(request('', 'PATCH', { clientId: CLIENT, status: 'resolved' }), ID), 400)
})

test('authority errors and idempotency/version conflicts return sanitized statuses', async () => {
  for (const [code, expected] of [['42501', 403], ['40001', 409], ['22023', 400], ['XX000', 500]] as const) {
    const { handlers } = harness(auth, rpc('create_outreach_comment', { code, message: 'private SQL secret' }, 400))
    await error(await handlers.create(request('', 'POST', { clientId: CLIENT, commandId: COMMAND, title: 'Change', body: 'Text' })), expected)
  }
})
