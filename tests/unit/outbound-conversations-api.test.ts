import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOutboundConversationHandlers, type OutboundConversationApiConfig } from '../../src/lib/outbound-conversations-api.ts'

const CLIENT = '10000000-0000-4000-8000-000000000001'
const CONVERSATION = '20000000-0000-4000-8000-000000000001'
const MESSAGE = '30000000-0000-4000-8000-000000000001'
const COMMAND = '40000000-0000-4000-8000-000000000001'
const CLAIM = '60000000-0000-4000-8000-000000000001'
const OTHER = '10000000-0000-4000-8000-000000000002'
const JWT = 'fixture-user-jwt'
const BASE = 'http://localhost/api/outbound/conversations'
type Reply = { path: string; body: unknown; status?: number }
const auth = { path: '/auth/v1/user', body: { id: '50000000-0000-4000-8000-000000000001', email: 'member@example.test', email_confirmed_at: '2026-10-03T00:00:00Z' } }
const summary = {
  id: CONVERSATION, clientId: CLIENT, channel: 'email', campaignId: null, campaignName: '',
  subject: 'A question', contactName: 'A prospect', contactAddress: 'prospect@example.test', senderLabel: 'sender@example.test',
  owner: { kind: 'covora', userId: null, name: 'Covora' }, ownedByMe: false, version: 1,
  latestMessageId: MESSAGE, latestAt: '2026-10-03T12:00:00Z', preview: 'Hello', unread: true, status: 'needs_reply', interest: null,
  canReply: true, canTakeover: true, replyUnavailableReason: null,
}
const message = { id: MESSAGE, direction: 'received', bodyText: '<script>plain text only</script>', sentAt: summary.latestAt, senderLabel: summary.contactAddress }
const detail = { ...summary, messages: [message], commands: [], messagesTruncated: false }
const command = { id: COMMAND, conversationId: CONVERSATION, bodyText: 'Hello there.', status: 'pending', createdAt: summary.latestAt, updatedAt: summary.latestAt, actorName: 'Member' }
const context = { channel: 'email' as const, credentialRef: 'OUTREACH_INSTANTLY_TEST', remoteWorkspaceId: OTHER, remoteSenderId: 'sender@example.test', senderAddress: 'sender@example.test', remoteConversationId: 'private-thread', remoteReplyToId: 'private-reply-id', remoteLatestMessageId: 'private-message', remoteCampaignId: null, contactAddress: 'prospect@example.test', latestMessageFingerprint: null, subject: 'A question', bodyText: 'Hello there.' }
const replyBody = { clientId: CLIENT, commandId: COMMAND, expectedVersion: 1, latestMessageId: MESSAGE, bodyText: 'Hello there.', takeover: true }
const finishRead = (status: string) => [auth, rpc('read_outreach_reply', { ...command, status }), rpc('read_outreach_conversation', { ...detail, commands: [{ ...command, status }] })]
const rpc = (name: string, body: unknown, status = 200): Reply => ({ path: `/rest/v1/rpc/${name}`, body, status })
function request(method = 'GET', body?: unknown, query = '') {
  return new Request(`${BASE}${query}`, { method, headers: { authorization: `Bearer ${JWT}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
function harness(replies: Reply[] = [], options: Partial<OutboundConversationApiConfig> = {}) {
  const calls: { request: Request; body: string }[] = []
  const handlers = createOutboundConversationHandlers({
    repliesEnabled: true, url: 'https://outbound-db.invalid', anonKey: 'fixture-public-key', serviceKey: 'fixture-service-key',
    ...options,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      calls.push({ request: req, body: await req.text() })
      const reply = replies.shift()
      assert.ok(reply, 'Unexpected database request')
      assert.equal(new URL(req.url).pathname, reply.path)
      return Response.json(reply.body, { status: reply.status ?? 200 })
    },
  })
  return { handlers, calls }
}

test('global reply disablement rejects before enqueue, claim or provider calls', async () => {
  const { handlers, calls } = harness([auth], { repliesEnabled: false })
  await errorResponse(await handlers.reply(request('POST', replyBody), CONVERSATION), 403)
  assert.equal(calls.length, 1)
  assert.equal(new URL(calls[0].request.url).pathname, '/auth/v1/user')
})

test('global reply disablement is reflected in readable conversation capabilities', async () => {
  const { handlers } = harness([auth, rpc('list_outreach_conversations', [summary])], { repliesEnabled: false })
  const response = await handlers.GET(request('GET', undefined, `?clientId=${CLIENT}`))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.conversations[0].canReply, false)
  assert.equal(body.conversations[0].replyUnavailableReason, 'Sending is currently disabled.')
  assert.equal(body.conversations[0].id, CONVERSATION)
})
async function errorResponse(response: Response, status: number) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('vary'), 'Authorization')
  const body = await response.json()
  assert.deepEqual(Object.keys(body), ['error'])
  assert.equal(typeof body.error, 'string')
  assert.doesNotMatch(body.error, /fixture|credential|provider|sql|secret/i)
}

test('every conversation route rejects cookies without a verified bearer before any database call', async () => {
  const { handlers, calls } = harness()
  const anonymous = new Request(BASE, { headers: { cookie: 'session=untrusted' } })
  for (const operation of [() => handlers.GET(anonymous), () => handlers.detail(anonymous, CONVERSATION), () => handlers.reply(anonymous, CONVERSATION), () => handlers.owner(anonymous, CONVERSATION), () => handlers.read(anonymous, CONVERSATION)]) {
    await errorResponse(await operation(), 401)
  }
  assert.equal(calls.length, 0)
})

test('a reply is durably claimed, prepared, fenced, sent once and returned only from its durable status', async () => {
  const events: string[] = []
  const { handlers, calls } = harness([auth, rpc('enqueue_outreach_reply', command), rpc('claim_outreach_reply', { claimToken: CLAIM, context }), rpc('dispatch_outreach_reply', true), rpc('finish_outreach_reply', true), ...finishRead('sent')], {
    provider: {
      prepare: async (value) => { events.push('prepare'); assert.deepEqual(value, context); return { ok: true, prepared: { context: value, preparedAt: Date.now() } } },
      send: async () => { events.push('send'); assert.equal(calls.at(-1)?.request.url.endsWith('/dispatch_outreach_reply'), true); return { status: 'sent', remoteMessageId: 'private-delivery-id' } },
    },
  })
  const response = await handlers.reply(request('POST', { ...replyBody, bodyText: '  Hello there.\n' }), CONVERSATION)
  assert.equal(response.status, 200)
  assert.deepEqual(events, ['prepare', 'send'])
  const body = await response.json()
  assert.equal(body.command.status, 'sent')
  assert.equal(body.conversation.id, CONVERSATION)
  assert.doesNotMatch(JSON.stringify(body), /private-|credentialRef|remoteWorkspace/)
  assert.deepEqual(JSON.parse(calls[1].body), { p_client_id: CLIENT, p_conversation_id: CONVERSATION, p_command_id: COMMAND, p_expected_version: 1, p_latest_message_id: MESSAGE, p_body: 'Hello there.', p_takeover: true })
  assert.deepEqual(JSON.parse(calls[4].body), { p_command_id: COMMAND, p_claim_token: CLAIM, p_status: 'sent', p_remote_message_id: 'private-delivery-id' })
  assert.equal(calls[1].request.headers.get('authorization'), `Bearer ${JWT}`)
  for (const call of calls.slice(2, 5)) assert.equal(call.request.headers.get('authorization'), 'Bearer fixture-service-key')
  for (const call of calls.slice(5)) assert.equal(call.request.headers.get('authorization'), `Bearer ${JWT}`)
})

test('replayed sent, failed, sending and unknown commands never claim or dispatch again', async () => {
  for (const status of ['sent', 'failed', 'sending', 'unknown']) {
    const { handlers, calls } = harness([auth, rpc('enqueue_outreach_reply', { ...command, status }), ...finishRead(status)])
    const response = await handlers.reply(request('POST', replyBody), CONVERSATION)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).command.status, status)
    assert.equal(calls.some(({ request }) => request.url.includes('claim_outreach_reply')), false)
  }
})

test('a concurrent pending command that cannot be claimed is observed without provider work', async () => {
  const { handlers, calls } = harness([auth, rpc('enqueue_outreach_reply', command), rpc('claim_outreach_reply', null), ...finishRead('pending')])
  const response = await handlers.reply(request('POST', replyBody), CONVERSATION)
  assert.equal((await response.json()).command.status, 'pending')
  assert.equal(calls.length, 6)
})

test('permission or latest-message changes during preparation prevent a provider send', async () => {
  let sends = 0
  const { handlers } = harness([auth, rpc('enqueue_outreach_reply', command), rpc('claim_outreach_reply', { claimToken: CLAIM, context }), rpc('dispatch_outreach_reply', false), ...finishRead('failed')], {
    provider: { prepare: async () => ({ ok: true, prepared: { context, preparedAt: Date.now() } }), send: async () => { sends++; return { status: 'sent', remoteMessageId: null } } },
  })
  const response = await handlers.reply(request('POST', replyBody), CONVERSATION)
  assert.equal((await response.json()).command.status, 'failed')
  assert.equal(sends, 0)
})

test('preparation failures end the command without dispatch and never expose internal diagnostics', async () => {
  for (const reason of ['unavailable', 'changed', 'identity_mismatch'] as const) {
    const { handlers, calls } = harness([auth, rpc('enqueue_outreach_reply', command), rpc('claim_outreach_reply', { claimToken: CLAIM, context }), rpc('finish_outreach_reply', true), ...finishRead('failed')], {
      provider: { prepare: async () => ({ ok: false, reason }), send: async () => { throw new Error('Unexpected send') } },
    })
    const response = await handlers.reply(request('POST', replyBody), CONVERSATION)
    assert.equal((await response.json()).command.status, 'failed')
    assert.deepEqual(JSON.parse(calls[3].body), { p_command_id: COMMAND, p_claim_token: CLAIM, p_status: 'failed', p_error_code: `prepare_${reason}` })
  }
})

test('an exception after dispatch is persisted as unknown and never retried', async () => {
  let sends = 0
  const { handlers, calls } = harness([auth, rpc('enqueue_outreach_reply', command), rpc('claim_outreach_reply', { claimToken: CLAIM, context }), rpc('dispatch_outreach_reply', true), rpc('finish_outreach_reply', true), ...finishRead('unknown')], {
    provider: { prepare: async () => ({ ok: true, prepared: { context, preparedAt: Date.now() } }), send: async () => { sends++; throw new Error('private provider credential') } },
  })
  const response = await handlers.reply(request('POST', replyBody), CONVERSATION)
  assert.equal((await response.json()).command.status, 'unknown')
  assert.equal(sends, 1)
  assert.deepEqual(JSON.parse(calls[4].body), { p_command_id: COMMAND, p_claim_token: CLAIM, p_status: 'unknown', p_error_code: 'dispatch_unknown' })
})

test('browser cancellation after dispatch cannot cancel durable unknown finalization', async () => {
  const controller = new AbortController()
  const { handlers, calls } = harness([auth, rpc('enqueue_outreach_reply', command), rpc('claim_outreach_reply', { claimToken: CLAIM, context }), rpc('dispatch_outreach_reply', true), rpc('finish_outreach_reply', true)], {
    provider: { prepare: async () => ({ ok: true, prepared: { context, preparedAt: Date.now() } }), send: async () => { controller.abort(); throw new Error('Aborted') } },
  })
  const req = new Request(request('POST', replyBody), { signal: controller.signal })
  await errorResponse(await handlers.reply(req, CONVERSATION), 500)
  assert.equal(calls.length, 5)
  assert.equal(calls[4].request.signal.aborted, false)
  assert.equal(JSON.parse(calls[4].body).p_status, 'unknown')
})

test('a failed durable finalization never fabricates successful command status', async () => {
  const { handlers, calls } = harness([auth, rpc('enqueue_outreach_reply', command), rpc('claim_outreach_reply', { claimToken: CLAIM, context }), rpc('dispatch_outreach_reply', true), rpc('finish_outreach_reply', { message: 'private' }, 503)], {
    provider: { prepare: async () => ({ ok: true, prepared: { context, preparedAt: Date.now() } }), send: async () => ({ status: 'sent', remoteMessageId: 'private' }) },
  })
  await errorResponse(await handlers.reply(request('POST', replyBody), CONVERSATION), 500)
  assert.equal(calls.length, 5)
})

test('malformed, changed-body and foreign enqueued commands never reach private service access', async () => {
  for (const row of [{ ...command, id: CLAIM }, { ...command, conversationId: OTHER }, { ...command, bodyText: 'Different body' }]) {
    const { handlers, calls } = harness([auth, rpc('enqueue_outreach_reply', row)])
    await errorResponse(await handlers.reply(request('POST', replyBody), CONVERSATION), 500)
    assert.equal(calls.length, 2)
  }
})

test('LinkedIn reply commands use the same guarded dispatch path and neutral DTO', async () => {
  const linkedinContext = { ...context, channel: 'linkedin' as const, credentialRef: 'OUTREACH_HEYREACH_TEST', remoteSenderId: '123', senderAddress: '', contactAddress: 'https://www.linkedin.com/in/prospect' }
  const linkedinDetail = { ...detail, channel: 'linkedin', subject: '', commands: [{ ...command, status: 'sent' }] }
  const { handlers } = harness([auth, rpc('enqueue_outreach_reply', command), rpc('claim_outreach_reply', { claimToken: CLAIM, context: linkedinContext }), rpc('dispatch_outreach_reply', true), rpc('finish_outreach_reply', true), auth, rpc('read_outreach_reply', { ...command, status: 'sent' }), rpc('read_outreach_conversation', linkedinDetail)], {
    provider: { prepare: async (value) => { assert.deepEqual(value, linkedinContext); return { ok: true, prepared: { context: value, preparedAt: Date.now() } } }, send: async () => ({ status: 'sent', remoteMessageId: 'private-linkedin-message' }) },
  })
  const response = await handlers.reply(request('POST', replyBody), CONVERSATION)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).conversation.channel, 'linkedin')
})

test('a failed or ambiguous SQL dispatch response never authorizes an external send', async () => {
  let sends = 0
  const { handlers, calls } = harness([auth, rpc('enqueue_outreach_reply', command), rpc('claim_outreach_reply', { claimToken: CLAIM, context }), rpc('dispatch_outreach_reply', { message: 'private' }, 503), rpc('finish_outreach_reply', true), ...finishRead('failed')], {
    provider: { prepare: async () => ({ ok: true, prepared: { context, preparedAt: Date.now() } }), send: async () => { sends++; return { status: 'sent', remoteMessageId: null } } },
  })
  const response = await handlers.reply(request('POST', replyBody), CONVERSATION)
  assert.equal((await response.json()).command.status, 'failed')
  assert.equal(sends, 0)
  assert.equal(JSON.parse(calls[4].body).p_status, 'failed')
})

test('failed completion fences return actual durable state instead of the adapter observation', async () => {
  const { handlers } = harness([auth, rpc('enqueue_outreach_reply', command), rpc('claim_outreach_reply', { claimToken: CLAIM, context }), rpc('dispatch_outreach_reply', true), rpc('finish_outreach_reply', false), ...finishRead('unknown')], {
    provider: { prepare: async () => ({ ok: true, prepared: { context, preparedAt: Date.now() } }), send: async () => ({ status: 'sent', remoteMessageId: 'private' }) },
  })
  const response = await handlers.reply(request('POST', replyBody), CONVERSATION)
  assert.equal((await response.json()).command.status, 'unknown')
})

test('private claim shape and body mismatch fail closed before provider preparation', async () => {
  for (const claim of [{ claimToken: 'invalid', context }, { claimToken: CLAIM, context: { ...context, bodyText: 'Another reply' } }, { claimToken: CLAIM, context: { ...context, remoteConversationId: '' } }]) {
    let prepares = 0
    const { handlers, calls } = harness([auth, rpc('enqueue_outreach_reply', command), rpc('claim_outreach_reply', claim)], {
      provider: { prepare: async () => { prepares++; return { ok: false, reason: 'unavailable' } }, send: async () => { throw new Error('Unexpected send') } },
    })
    await errorResponse(await handlers.reply(request('POST', replyBody), CONVERSATION), 500)
    assert.equal(prepares, 0)
    assert.equal(calls.length, 3)
  }
})

test('revoked authority, stale inputs and infrastructure errors are neutral before service access', async () => {
  for (const [code, status] of [['42501', 403], ['22023', 400], ['XX000', 500]] as const) {
    const { handlers, calls } = harness([auth, rpc('enqueue_outreach_reply', { code, message: 'fixture secret credential' }, 400)])
    await errorResponse(await handlers.reply(request('POST', replyBody), CONVERSATION), status)
    assert.equal(calls.length, 2)
  }
})

test('private database work has a bounded deadline before any provider dispatch', async () => {
  let aborted = false
  let count = 0
  const handlers = createOutboundConversationHandlers({
    repliesEnabled: true, url: 'https://outbound-db.invalid', anonKey: 'fixture-public-key', serviceKey: 'fixture-service-key', timeoutMs: 100,
    fetch: async (input, init) => {
      const req = new Request(input, init)
      count++
      if (new URL(req.url).pathname === '/auth/v1/user') return Response.json(auth.body)
      if (new URL(req.url).pathname === '/rest/v1/rpc/enqueue_outreach_reply') return Response.json(command)
      return new Promise<Response>((_resolve, reject) => req.signal.addEventListener('abort', () => { aborted = true; reject(new Error('private transport diagnostic')) }, { once: true }))
    },
  })
  // Keep the test process alive while AbortSignal's unref'd timer expires.
  const keepAlive = setTimeout(() => {}, 1000)
  try { await errorResponse(await handlers.reply(request('POST', replyBody), CONVERSATION), 500) }
  finally { clearTimeout(keepAlive) }
  assert.equal(aborted, true)
  assert.equal(count, 3)
})

test('conversation queries reject unknown, duplicate, malformed and foreign cursor input', async () => {
  for (const query of ['', '?clientId=bad', `?clientId=${CLIENT}&clientId=${CLIENT}`, `?clientId=${CLIENT}&channel=other`, `?clientId=${CLIENT}&key=secret`, `?clientId=${CLIENT}&cursor=invalid`]) {
    const { handlers, calls } = harness([auth])
    await errorResponse(await handlers.GET(request('GET', undefined, query)), 400)
    assert.equal(calls.length, 1)
  }
})

test('reply input cannot inject private destinations, exceed limits or omit explicit takeover', async () => {
  const valid = { clientId: CLIENT, commandId: COMMAND, expectedVersion: 1, latestMessageId: MESSAGE, bodyText: 'Hello there.', takeover: false }
  for (const value of [{ ...valid, apiKey: 'secret' }, { ...valid, expectedVersion: 0 }, { ...valid, expectedVersion: 1.1 }, { ...valid, bodyText: '  ' }, { ...valid, bodyText: 'x'.repeat(4001) }, { ...valid, takeover: undefined }, { ...valid, latestMessageId: 'invalid' }]) {
    const { handlers, calls } = harness([auth])
    await errorResponse(await handlers.reply(request('POST', value), CONVERSATION), 400)
    assert.equal(calls.length, 1)
  }
})

test('reply bodies are byte bounded even when Content-Length is dishonest', async () => {
  const { handlers, calls } = harness([auth])
  const req = new Request(BASE, { method: 'POST', headers: { authorization: `Bearer ${JWT}`, 'content-type': 'application/json', 'content-length': '2' }, body: JSON.stringify({ clientId: CLIENT, commandId: COMMAND, expectedVersion: 1, latestMessageId: MESSAGE, bodyText: '😀'.repeat(2500), takeover: false }) })
  await errorResponse(await handlers.reply(req, CONVERSATION), 400)
  assert.equal(calls.length, 1)
})

test('owner commands accept only me or Covora and reject query parameters and invalid path IDs', async () => {
  for (const [body, query, id] of [[{ clientId: CLIENT, expectedVersion: 1, owner: 'other-user' }, '', CONVERSATION], [{ clientId: CLIENT, expectedVersion: 1, owner: 'me' }, '?secret=value', CONVERSATION], [{ clientId: CLIENT, expectedVersion: 1, owner: 'covora' }, '', 'invalid']] as const) {
    const { handlers, calls } = harness([auth])
    await errorResponse(await handlers.owner(request('POST', body, query), id), 400)
    assert.equal(calls.length, 1)
  }
})

test('conversation lists expose only neutral fields through the current user RPC', async () => {
  const { handlers, calls } = harness([auth, rpc('list_outreach_conversations', [{ ...summary, credentialRef: 'private', remoteId: 'private' }])])
  const response = await handlers.GET(request('GET', undefined, `?clientId=${CLIENT}&channel=email`))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { conversations: [summary], nextCursor: null })
  assert.deepEqual(JSON.parse(calls[1].body), { p_client_id: CLIENT, p_channel: 'email', p_limit: 51 })
  assert.equal(calls[1].request.headers.get('authorization'), `Bearer ${JWT}`)
})

test('conversation interest remains available for outcome filters and missing values stay unavailable', async () => {
  for (const interest of ['Interested', 'Out of office', null]) {
    const { handlers } = harness([auth, rpc('list_outreach_conversations', [{ ...summary, interest }])])
    const response = await handlers.GET(request('GET', undefined, `?clientId=${CLIENT}`))
    assert.equal((await response.json()).conversations[0].interest, interest)
  }
  const missing: Record<string, unknown> = { ...summary }
  delete missing.interest
  const { handlers } = harness([auth, rpc('list_outreach_conversations', [missing])])
  assert.equal((await (await handlers.GET(request('GET', undefined, `?clientId=${CLIENT}`))).json()).conversations[0].interest, null)
})

test('pagination returns 50 rows with an opaque cursor bound to workspace and channel', async () => {
  const rows = Array.from({ length: 51 }, (_, index) => ({ ...summary, id: `20000000-0000-4000-8000-${String(100 - index).padStart(12, '0')}` }))
  const first = harness([auth, rpc('list_outreach_conversations', rows)])
  const page = await (await first.handlers.GET(request('GET', undefined, `?clientId=${CLIENT}&channel=email`))).json()
  assert.equal(page.conversations.length, 50)
  assert.equal(typeof page.nextCursor, 'string')
  const second = harness([auth, rpc('list_outreach_conversations', [rows[50]])])
  assert.equal((await second.handlers.GET(request('GET', undefined, `?clientId=${CLIENT}&channel=email&cursor=${page.nextCursor}`))).status, 200)
  assert.deepEqual(JSON.parse(second.calls[1].body), { p_client_id: CLIENT, p_channel: 'email', p_limit: 51, p_before_at: summary.latestAt, p_before_id: rows[49].id })
  for (const query of [`?clientId=${OTHER}&channel=email`, `?clientId=${CLIENT}&channel=linkedin`]) {
    const other = harness([auth])
    await errorResponse(await other.handlers.GET(request('GET', undefined, `${query}&cursor=${page.nextCursor}`)), 400)
    assert.equal(other.calls.length, 1)
  }
})

test('detail reads preserve plain text and unavailable history without modifying read state', async () => {
  const { handlers, calls } = harness([auth, rpc('read_outreach_conversation', { ...detail, private: 'secret', messagesTruncated: true })])
  const response = await handlers.detail(request('GET', undefined, `?clientId=${CLIENT}`), CONVERSATION)
  assert.deepEqual(await response.json(), { conversation: { ...detail, messagesTruncated: true } })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].request.headers.get('authorization'), `Bearer ${JWT}`)
})

test('malformed or cross-tenant projected data fails closed', async () => {
  for (const row of [{ ...summary, clientId: OTHER }, { ...summary, channel: 'other' }, { ...summary, owner: { kind: 'user', userId: null, name: 'Member' } }, { ...summary, version: 0 }]) {
    const { handlers } = harness([auth, rpc('list_outreach_conversations', [row])])
    await errorResponse(await handlers.GET(request('GET', undefined, `?clientId=${CLIENT}`)), 500)
  }
  for (const row of [{ ...detail, id: OTHER }, { ...detail, commands: [{ id: COMMAND, conversationId: OTHER, bodyText: 'Reply', status: 'unknown', createdAt: summary.latestAt, updatedAt: summary.latestAt, actorName: 'Member' }] }]) {
    const { handlers } = harness([auth, rpc('read_outreach_conversation', row)])
    await errorResponse(await handlers.detail(request('GET', undefined, `?clientId=${CLIENT}`), CONVERSATION), 500)
  }
})

test('read and owner mutations stay user scoped and project the resulting conversation', async () => {
  const read = harness([auth, rpc('mark_outreach_conversation_read', null)])
  assert.deepEqual(await (await read.handlers.read(request('POST', { clientId: CLIENT }), CONVERSATION)).json(), { ok: true })
  assert.deepEqual(JSON.parse(read.calls[1].body), { p_client_id: CLIENT, p_conversation_id: CONVERSATION })
  const owner = harness([auth, rpc('change_outreach_conversation_owner', detail)])
  assert.deepEqual(await (await owner.handlers.owner(request('POST', { clientId: CLIENT, expectedVersion: 1, owner: 'covora' }), CONVERSATION)).json(), { conversation: detail })
  assert.deepEqual(JSON.parse(owner.calls[1].body), { p_client_id: CLIENT, p_conversation_id: CONVERSATION, p_expected_version: 1, p_owner: 'covora' })
})
