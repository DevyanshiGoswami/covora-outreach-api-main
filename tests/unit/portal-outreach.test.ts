import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MOCK_WORKSPACE_ID, mockInstantlyFetch, readMockState, writeMockState } from '../../src/lib/instantly-mock.ts'
import { instantlyMode } from '../../src/lib/instantly-transport.ts'
import { portalOutreachAllowed, startPortalOutreach, type PortalOutreachContext } from '../../src/lib/portal-outreach-provider.ts'
import { prepareOutreachReply, sendOutreachReply } from '../../src/lib/outreach-reply-provider.ts'
import { handleInstantlyWebhook } from '../../src/lib/instantly-webhook.ts'

const directory = mkdtempSync(path.join(tmpdir(), 'covora-mock-'))
process.env.OUTREACH_INSTANTLY_MOCK_STATE = path.join(directory, 'state.json')
test.after(() => rmSync(directory, { recursive: true, force: true }))

const SENDER = 'alice.sender@covora-mock.test', RECIPIENT = 'priya@prospect-mock.test'
const credentials = { OUTREACH_INSTANTLY_TEST: 'private-test-key' }
const mockEnv = { OUTREACH_PORTAL_SEND_ENABLED: 'true', OUTREACH_INSTANTLY_MODE: 'mock' }
const context: PortalOutreachContext = { credentialRef: 'OUTREACH_INSTANTLY_TEST', remoteWorkspaceId: MOCK_WORKSPACE_ID, senderAddress: SENDER,
  recipientEmail: RECIPIENT, recipientFirstName: 'Priya', recipientLastName: 'Shah', recipientCompany: 'Northwind',
  subject: 'Quick idea', bodyText: 'Hi Priya,\nShort call next week?', campaignName: 'Covora outreach test' }
function resetMock() {
  writeMockState({ version: 1, workspaceId: MOCK_WORKSPACE_ID, accounts: [SENDER], campaigns: {}, leads: {}, emails: [] })
}
function recorder(fetcher: typeof fetch = mockInstantlyFetch) {
  const calls: Request[] = []
  return { calls, fetch: (async (input, init) => { calls.push(new Request(input, init)); return fetcher(input, init) }) as typeof fetch }
}

test('mock outreach creates one single-sender campaign, adds one lead and activates it', async () => {
  resetMock()
  const h = recorder()
  const outcome = await startPortalOutreach(context, { env: mockEnv, credentials, fetch: h.fetch })
  assert.equal(outcome.status, 'scheduled')
  assert.deepEqual(h.calls.map(r => `${r.method} ${new URL(r.url).pathname}`), ['GET /api/v2/workspaces/current', `GET /api/v2/accounts/${encodeURIComponent(SENDER)}`,
    'POST /api/v2/campaigns', 'POST /api/v2/leads', `POST /api/v2/campaigns/${outcome.providerCampaignId}/activate`])
  const created = await h.calls[2].clone().json()
  assert.deepEqual(created.email_list, [SENDER])
  assert.equal(created.sequences[0].steps.length, 1)
  assert.equal(created.sequences[0].steps[0].variants[0].body, 'Hi Priya,<br>Short call next week?')
  const state = readMockState()
  const sent = state.emails.filter(email => email.campaign_id === outcome.providerCampaignId)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].ue_type, 1)
  assert.equal(sent[0].lead, RECIPIENT)
  assert.equal(state.leads[outcome.providerLeadId!].campaign, outcome.providerCampaignId)
})

test('a reply to a mock outreach stays in the same provider thread', async () => {
  resetMock()
  const started = await startPortalOutreach(context, { env: mockEnv, credentials })
  const state = readMockState()
  const sent = state.emails.find(email => email.campaign_id === started.providerCampaignId)!
  const later = new Date(Date.parse(sent.timestamp_created) + 60_000).toISOString()
  const received = { ...sent, id: crypto.randomUUID(), timestamp_created: later, timestamp_email: later, ue_type: 2 as const, from_address_email: RECIPIENT, to_address_email_list: SENDER, body: { text: 'Sure' } }
  state.emails.push(received)
  writeMockState(state)
  const replyContext = { channel: 'email' as const, credentialRef: 'OUTREACH_INSTANTLY_TEST', remoteWorkspaceId: MOCK_WORKSPACE_ID, remoteSenderId: SENDER,
    senderAddress: SENDER, remoteConversationId: sent.thread_id, remoteReplyToId: received.id, remoteLatestMessageId: received.id,
    remoteCampaignId: started.providerCampaignId, contactAddress: RECIPIENT, latestMessageFingerprint: null, subject: 'Re: Quick idea', bodyText: 'Great, Tuesday 10am?' }
  const prepared = await prepareOutreachReply(replyContext, { credentials, repliesEnabled: true, fetch: mockInstantlyFetch })
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal((await sendOutreachReply(prepared.prepared, { credentials, repliesEnabled: true, fetch: mockInstantlyFetch })).status, 'sent')
  const thread = readMockState().emails.filter(email => email.thread_id === sent.thread_id)
  assert.deepEqual(thread.map(email => email.ue_type), [1, 2, 3])
})

test('live sends need the enable flag and both exact allowlists; otherwise no request is made', async () => {
  const live = { OUTREACH_PORTAL_SEND_ENABLED: 'true', OUTREACH_INSTANTLY_MODE: 'live', OUTREACH_PORTAL_ALLOWED_SENDERS: SENDER, OUTREACH_PORTAL_ALLOWED_RECIPIENTS: RECIPIENT }
  assert.equal(portalOutreachAllowed(context, live), true)
  for (const env of [{ ...live, OUTREACH_PORTAL_SEND_ENABLED: 'false' }, { ...live, OUTREACH_PORTAL_ALLOWED_RECIPIENTS: '' },
    { ...live, OUTREACH_PORTAL_ALLOWED_SENDERS: 'other@covora-mock.test' }, { ...live, OUTREACH_PORTAL_ALLOWED_RECIPIENTS: 'priya@prospect-mock.test.evil' }]) {
    const h = recorder(async () => { throw new Error('network must not be used') })
    const outcome = await startPortalOutreach(context, { env, credentials, fetch: h.fetch })
    assert.deepEqual(outcome, { status: 'failed', errorCode: 'prepare_unavailable', providerCampaignId: null, providerLeadId: null })
    assert.equal(h.calls.length, 0)
  }
  assert.throws(() => instantlyMode({ OUTREACH_INSTANTLY_MODE: 'mock', NODE_ENV: 'production' }))
})

test('wrong workspace or unknown sender refuses before any write', async () => {
  resetMock()
  for (const patch of [{ remoteWorkspaceId: '11111111-1111-4111-8111-111111111111' }, { senderAddress: 'not-connected@covora-mock.test' }]) {
    const h = recorder()
    const outcome = await startPortalOutreach({ ...context, ...patch }, { env: mockEnv, credentials, fetch: h.fetch })
    assert.equal(outcome.status, 'failed')
    assert.equal(h.calls.some(r => r.method === 'POST'), false)
  }
})

test('ambiguous provider writes are unknown, keep the created campaign id and are attempted once', async () => {
  resetMock()
  let posts = 0
  const flaky: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/activate')) { posts++; throw new Error('socket closed') }
    return mockInstantlyFetch(input, init)
  }
  const outcome = await startPortalOutreach(context, { env: mockEnv, credentials, fetch: flaky })
  assert.equal(outcome.status, 'unknown')
  assert.ok(outcome.providerCampaignId && outcome.providerLeadId)
  assert.equal(posts, 1)
  const rejected = await startPortalOutreach(context, { env: mockEnv, credentials,
    fetch: async (input, init) => new Request(input, init).method === 'POST' ? new Response('', { status: 422 }) : mockInstantlyFetch(input, init) })
  assert.deepEqual(rejected, { status: 'failed', errorCode: 'dispatch_rejected', providerCampaignId: null, providerLeadId: null })
})

const SECRET = 'a'.repeat(40)
const webhookEnv = { OUTREACH_INSTANTLY_WEBHOOK_SECRET: SECRET }
function webhookRequest(body: unknown, secret: string | null = SECRET) {
  return new Request('http://127.0.0.1:3011/api/webhooks/instantly', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-covora-webhook-secret': secret } : {}) }, body: JSON.stringify(body) })
}
const event = { event_type: 'reply_received', campaign_id: 'c1', lead_email: 'Priya@Prospect-Mock.test', email_id: 'e1', reply_text: 'private text' }

test('webhook requires its secret and never forwards message text', async () => {
  const keys: string[][] = []
  const record = async (...args: string[]) => { keys.push(args); return 'queued' }
  assert.equal((await handleInstantlyWebhook(webhookRequest(event, null), { env: webhookEnv, record })).status, 401)
  assert.equal((await handleInstantlyWebhook(webhookRequest(event, 'b'.repeat(40)), { env: webhookEnv, record })).status, 401)
  assert.equal((await handleInstantlyWebhook(webhookRequest(event), { env: {}, record })).status, 404)
  assert.equal(keys.length, 0)
  const ok = await handleInstantlyWebhook(webhookRequest(event), { env: webhookEnv, record })
  assert.equal(ok.status, 200)
  assert.deepEqual(keys[0].slice(1), ['c1', 'priya@prospect-mock.test'])
  assert.equal(JSON.stringify(keys).includes('private text'), false)
})

test('the same webhook event twice maps to one key; other events and malformed bodies are not queued', async () => {
  const keys: string[] = []
  const record = async (key: string) => { const duplicate = keys.includes(key); keys.push(key); return duplicate ? 'duplicate' : 'queued' }
  const first = await (await handleInstantlyWebhook(webhookRequest(event), { env: webhookEnv, record })).json()
  const second = await (await handleInstantlyWebhook(webhookRequest(event), { env: webhookEnv, record })).json()
  assert.deepEqual([first.result, second.result], ['queued', 'duplicate'])
  assert.match(keys[0], /^[a-f0-9]{64}$/)
  for (const body of [{ ...event, event_type: 'email_sent' }, { ...event, campaign_id: undefined }]) {
    assert.equal((await (await handleInstantlyWebhook(webhookRequest(body), { env: webhookEnv, record })).json()).result, 'ignored')
  }
  assert.equal((await handleInstantlyWebhook(webhookRequest({ ...event, lead_email: 'not an email' }), { env: webhookEnv, record })).status, 400)
  assert.equal(keys.length, 2)
  const failing = await handleInstantlyWebhook(webhookRequest(event), { env: webhookEnv, record: async () => { throw new Error('db down') } })
  assert.equal(failing.status, 503)
})
