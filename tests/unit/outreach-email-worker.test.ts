import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { syncOutreach } from '../../src/lib/outreach-sync-worker.ts'
import { stubFetch, type FetchCall } from './helpers/fetch.ts'

const clientId = '11111111-1111-4111-8111-111111111111'
const campaignId = '22222222-2222-4222-8222-222222222222'
const remoteId = '33333333-3333-4333-8333-333333333333'
const workspaceId = '44444444-4444-4444-8444-444444444444'
const sender = 'sender@example.test'
const now = new Date().toISOString()
const message = { id: 'remote-message', campaign_id: remoteId, eaccount: sender, ue_type: 2,
  timestamp_email: now, timestamp_created: now, thread_id: 'thread', lead: 'lead@example.test',
  from_address_email: 'lead@example.test', to_address_email_list: sender, subject: 'Hello', body: { text: 'Interested' } }

function harness(t: TestContext, options: {
  remote?: Record<string, unknown>; items?: unknown[]; assigned?: boolean; permit?: boolean;
  cursor?: string; nextCursor?: string; replyWatermark?: string; queue?: boolean; dailyDue?: boolean;
} = {}) {
  const env = { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:60321', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'unit-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'unit-service', OUTREACH_SUPABASE_PROJECT_REF: 'local-outreach',
    OUTREACH_SYNC_ENABLED: 'true', OUTREACH_INSTANTLY_UNIT: 'unit-scoped-key' }
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const state = { campaign_id: campaignId, client_id: clientId, last_served_at: null, reply_cursor: options.cursor ?? null,
    reply_watermark: options.replyWatermark ?? null, reply_scan_started_at: options.cursor ? now : null,
    meta_synced_at: now, daily_synced_at: options.dailyDue ? null : now, leads_synced_at: now, replies_synced_at: null,
    lead_cursor: null, last_email_kind: options.queue ? 'poll' : null, attempt_count: 0,
    outreach_campaigns: { id: campaignId, client_id: clientId, provider_campaign_id: remoteId, channel: 'email', messages_purged_at: null, totals: {} } }
  const db = (call: FetchCall) => {
    const url = new URL(call.url), table = url.pathname.split('/').at(-1)
    if (url.pathname.includes('/rpc/')) return { body: table === 'purge_outreach_messages' ? false : table === 'reserve_outreach_email_request' ? options.permit !== false : true }
    if (call.method !== 'GET') return { body: null }
    if (table === 'outreach_sync_state') return { body: options.assigned === false ? [] : [state] }
    if (table === 'outreach_reply_workspaces') return { body: { id: workspaceId, version: 1, remote_workspace_id: workspaceId, credential_ref: 'OUTREACH_INSTANTLY_UNIT', sync_enabled: true } }
    if (table === 'outreach_reply_senders') return { body: url.searchParams.get('channel') === 'eq.linkedin' ? [] : [
      { remote_sender_id: sender, sender_address: sender, enabled: false },
      { remote_sender_id: 'other-approved@example.test', sender_address: 'other-approved@example.test', enabled: false },
    ] }
    if (table === 'client_features') return { body: { enabled: true } }
    if (table === 'outreach_fetch_queue') return { body: options.queue ? { id: 'queue', campaign_id: campaignId, client_id: clientId,
      lead_email: '', provider_thread_id: 'thread', cursor: options.cursor ?? null, requested_at: now, attempt_count: 0 } : null }
    throw new Error('Unexpected database test request')
  }
  const stub = stubFetch({
    '127.0.0.1:60321': db,
    '/workspaces/current': { body: { id: workspaceId } },
    [`/campaigns/${remoteId}`]: { body: { id: remoteId, name: 'Reviewed campaign', status: 2,
      timestamp_created: '2026-10-01T00:00:00Z', organization: workspaceId, email_list: [sender], ...options.remote } },
    '/campaigns/analytics/daily': { body: [{ date: '2026-10-01', sent: 4, unique_replies: 1 }] },
    '/emails': { body: { items: options.items ?? [message], ...(options.nextCursor ? { next_starting_after: options.nextCursor } : {}) } },
  })
  t.after(stub.restore)
  return { calls: stub.calls, run: () => syncOutreach({ deadline: Date.now() + 45_000, timeLeft: () => 40_000 }) }
}

const providerCalls = (calls: FetchCall[]) => calls.filter(call => new URL(call.url).hostname === 'api.instantly.ai')
const writes = (calls: FetchCall[], table: string) => calls.filter(call => new URL(call.url).pathname.endsWith('/' + table) && call.method !== 'GET')

test('sync checks approved assignment and exact campaign senders before reading history; sending disabled still permits reads', async t => {
  const h = harness(t), result = await h.run()
  assert.equal(result.messages, 1)
  assert.deepEqual(providerCalls(h.calls).map(call => new URL(call.url).pathname), [
    '/api/v2/workspaces/current', `/api/v2/campaigns/${remoteId}`, '/api/v2/emails',
  ])
  const candidates = h.calls.find(call => call.url.includes('/outreach_sync_state') && call.method === 'GET')!
  assert.equal(new URL(candidates.url).searchParams.get('outreach_campaigns.channel'), 'eq.email')
  const senders = h.calls.find(call => call.url.includes('/outreach_reply_senders') && new URL(call.url).searchParams.get('channel') === 'eq.email')!
  const query = new URL(senders.url).searchParams
  assert.equal(query.get('workspace_id'), `eq.${workspaceId}`)
  assert.equal(query.get('client_id'), `eq.${clientId}`)
  assert.equal(query.has('enabled'), false)
})

test('no reviewed campaign assignment means no provider access even with approved sender credentials', async t => {
  const h = harness(t, { assigned: false }); await h.run()
  assert.equal(providerCalls(h.calls).length, 0)
})

for (const [name, remote] of Object.entries({
  foreign_sender: { email_list: [sender, 'foreign@example.test'] },
  missing_senders: { email_list: undefined }, empty_senders: { email_list: [] },
  unknown_tag_senders: { email_tag_list: ['unresolved-tag'] },
  wrong_campaign_same_sender: { id: 'other-client-campaign' },
  wrong_workspace: { organization: '55555555-5555-4555-8555-555555555555' },
})) test(`campaign scope rejects ${name} before any history read or mirror write`, async t => {
  const h = harness(t, { remote }), result = await h.run()
  assert.equal(result.failed, 1)
  assert.equal(providerCalls(h.calls).some(call => call.url.includes('/emails')), false)
  assert.equal(writes(h.calls, 'outreach_messages').length, 0)
})

for (const [name, wrong] of Object.entries({
  other_campaign_same_sender: { campaign_id: 'diowave-campaign' },
  foreign_sender: { eaccount: 'foreign@example.test' },
  bound_but_not_campaign_sender: { eaccount: 'other-approved@example.test' },
  missing_sender: { eaccount: undefined },
  foreign_workspace: { organization_id: '55555555-5555-4555-8555-555555555555' },
})) test(`a mixed page with ${name} is not written or checkpointed`, async t => {
  const h = harness(t, { items: [message, { ...message, id: 'second', ...wrong }], nextCursor: 'next' }), result = await h.run()
  assert.equal(result.failed, 1)
  assert.equal(writes(h.calls, 'outreach_messages').length, 0)
  assert.equal(writes(h.calls, 'outreach_fetch_queue').length, 0)
  for (const call of writes(h.calls, 'outreach_sync_state')) {
    const patch = JSON.parse(call.body!)
    assert.equal('reply_cursor' in patch || 'reply_watermark' in patch, false)
  }
})

test('resumed reply page preserves bounded request scope and only advances cursor after valid writes', async t => {
  const watermark = '2026-10-01T00:00:00Z'
  const h = harness(t, { cursor: 'page-2', nextCursor: 'page-3', replyWatermark: watermark }), result = await h.run()
  assert.equal(result.messages, 1)
  const query = new URL(providerCalls(h.calls).find(call => call.url.includes('/emails'))!.url).searchParams
  assert.equal(query.get('campaign_id'), remoteId)
  assert.equal(query.has('email_type'), false)
  assert.equal(query.get('starting_after'), 'page-2')
  assert.equal(query.get('max_timestamp_created'), now)
  const checkpoint = writes(h.calls, 'outreach_sync_state').map(call => JSON.parse(call.body!)).find(patch => patch.reply_cursor)
  assert.equal(checkpoint.reply_cursor, 'page-3')
  assert.equal(checkpoint.reply_watermark, watermark)
  assert.equal(result.email_attempts, 1)
})

test('denied global email permit reads no email page and does not advance the cursor', async t => {
  const h = harness(t, { permit: false, cursor: 'resume' }), result = await h.run()
  assert.equal(result.deferred, 1)
  assert.equal(providerCalls(h.calls).some(call => call.url.includes('/emails')), false)
  assert.equal(writes(h.calls, 'outreach_messages').length, 0)
  assert.equal(writes(h.calls, 'outreach_sync_state').some(call => 'reply_cursor' in JSON.parse(call.body!)), false)
})

test('queued thread context applies the same sender scope before writes and queue completion', async t => {
  const h = harness(t, { queue: true, items: [{ ...message, eaccount: 'foreign@example.test' }] }), result = await h.run()
  assert.equal(result.failed, 1)
  assert.equal(writes(h.calls, 'outreach_messages').length, 0)
  assert.equal(writes(h.calls, 'outreach_fetch_queue').some(call => 'completed_at' in JSON.parse(call.body!)), false)
})

test('an oversized provider page fails without partial writes or a pagination checkpoint', async t => {
  const h = harness(t, { items: Array.from({ length: 101 }, (_, index) => ({ ...message, id: `message-${index}` })) })
  const result = await h.run()
  assert.equal(result.failed, 1)
  assert.equal(writes(h.calls, 'outreach_messages').length, 0)
  assert.equal(writes(h.calls, 'outreach_sync_state').some(call => 'reply_cursor' in JSON.parse(call.body!)), false)
})

test('campaign polling imports sent follow-ups after thread context completed and skips scheduled or unknown messages', async t => {
  const outgoing = { ...message, from_address_email: sender, to_address_email_list: 'lead@example.test' }
  const h = harness(t, { items: [message, { ...outgoing, id: 'campaign-sent', ue_type: 1 },
    { ...outgoing, id: 'external-followup', ue_type: 3 }, { ...outgoing, id: 'scheduled', ue_type: 4 },
    { ...outgoing, id: 'unknown', ue_type: 99 }] })
  const result = await h.run()
  assert.equal(result.messages, 3)
  const query = new URL(providerCalls(h.calls).find(call => call.url.includes('/emails'))!.url).searchParams
  assert.equal(query.has('email_type'), false)
  assert.equal(query.get('mode'), 'emode_all')
  assert.equal(query.get('latest_of_thread'), 'false')
  const rows = JSON.parse(writes(h.calls, 'outreach_messages')[0].body!)
  assert.deepEqual(rows.map((row: { provider_email_id: string; direction: string }) => [row.provider_email_id, row.direction]),
    [['remote-message', 'received'], ['campaign-sent', 'sent'], ['external-followup', 'sent']])
})

test('daily results checkpoint without requesting unused step analytics', async t => {
  const h = harness(t, { dailyDue: true }), result = await h.run()
  assert.equal(result.failed, 0)
  assert.equal(providerCalls(h.calls).some(call => call.url.includes('/analytics/steps')), false)
  const call = providerCalls(h.calls).find(call => call.url.includes('/analytics/daily'))!
  assert.equal(new URL(call.url).searchParams.get('campaign_id'), remoteId)
  assert.equal(new URL(call.url).searchParams.get('start_date'), '2026-10-01')
  const rows = JSON.parse(writes(h.calls, 'outreach_campaign_daily')[0].body!)
  assert.equal(rows[0].sent, 4)
  assert.equal(rows[0].unique_replies, 1)
  assert.equal(writes(h.calls, 'outreach_sync_state').some(call => 'daily_synced_at' in JSON.parse(call.body!)), true)
})
