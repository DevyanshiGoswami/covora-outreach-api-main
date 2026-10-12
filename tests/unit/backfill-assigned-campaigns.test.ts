import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { backfillAssignedCampaigns } from '../../scripts/backfill-assigned-campaigns'
import { stubFetch, type FetchCall } from './helpers/fetch'

const project = 'uuqrewifuwscnyxepjbh'
const client = '11111111-1111-4111-8111-111111111111'
const local = '22222222-2222-4222-8222-222222222222'
const remote = '33333333-3333-4333-8333-333333333333'
const workspace = '44444444-4444-4444-8444-444444444444'
const secondLocal = '55555555-5555-4555-8555-555555555555'
const secondRemote = '66666666-6666-4666-8666-666666666666'
const sender = 'sender@example.test'
const manifest = { projectRef: project, clientId: client, remoteWorkspaceId: workspace, campaignIds: [remote], senderAddresses: [sender] }
const isProvider = (call: FetchCall) => new URL(call.url).hostname === 'api.instantly.ai'
const tableWrites = (calls: FetchCall[]) => calls.filter(call => !isProvider(call) && !call.url.includes('/rpc/') && !['GET', 'HEAD'].includes(call.method))

function harness(t: TestContext, options: {
  lease?: boolean; loseLease?: boolean; providerWorkspace?: string; campaignSender?: string; changedBinding?: boolean;
  secondPage?: Record<string, unknown>; extraAssignment?: boolean; senderlessDraft?: boolean; totals?: Record<string, unknown> | null;
  secondCampaign?: boolean; previousTotals?: Record<string, number | boolean>; emptyDaily?: boolean;
} = {}) {
  const env = { NEXT_PUBLIC_SUPABASE_URL: `https://${project}.supabase.co`, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'unit-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'unit-service', OUTREACH_SUPABASE_PROJECT_REF: project,
    OUTREACH_INSTANTLY_TEST_BACKFILL: 'unit-scoped-key' }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  let leases = 0, bindings = 0
  const leadReads = new Map<string, number>(), completedAt = new Map<string, string>()
  const storedTotals = new Map<string, Record<string, number | boolean>>()
  const remoteCampaign = (id: string) => ({ id, name: 'Assigned campaign', organization: workspace,
    status: options.senderlessDraft ? 0 : 3, email_list: options.senderlessDraft ? [] : [options.campaignSender ?? sender],
    timestamp_created: '2026-10-01T00:00:00Z', sequences: [{ steps: [{ type: 'email', delay: 48, delay_unit: 'hours',
      variants: [{ subject: 'A question', body: '<p>Hello</p>' }] }] }],
  })
  const stub = stubFetch({
    [`${project}.supabase.co`]: call => {
      const url = new URL(call.url), table = url.pathname.split('/').at(-1)
      if (table === 'acquire_outreach_sync_lock') return { body: options.lease !== false && !(options.loseLease && ++leases > 3) }
      if (table === 'release_outreach_sync_lock') return { body: true }
      if (url.pathname.includes('/rpc/')) throw new Error('Unexpected RPC')
      if (!['GET', 'HEAD'].includes(call.method)) {
        if (table === 'outreach_campaigns') {
          const id = url.searchParams.get('id')!.slice(3), patch = JSON.parse(call.body!)
          completedAt.set(id, patch.completed_at)
          storedTotals.set(id, patch.totals)
        }
        return { body: null }
      }
      if (table === 'client_features') return { body: { enabled: true, config: {} } }
      if (table === 'outreach_reply_workspaces') return { body: { id: workspace, remote_workspace_id: workspace,
        credential_ref: 'OUTREACH_INSTANTLY_TEST_BACKFILL', sync_enabled: true, version: options.changedBinding && ++bindings > 2 ? 2 : 1 } }
      if (table === 'outreach_campaigns') return { body: [
        { id: local, client_id: client, provider_campaign_id: remote, completed_at: completedAt.get(local) ?? null,
          totals: storedTotals.get(local) ?? options.previousTotals ?? {} },
        ...(options.secondCampaign ? [{ id: secondLocal, client_id: client, provider_campaign_id: secondRemote, completed_at: completedAt.get(secondLocal) ?? null,
          totals: storedTotals.get(secondLocal) ?? options.previousTotals ?? {} }] : []),
        ...(options.extraAssignment ? [{ id: workspace, client_id: client, provider_campaign_id: workspace, completed_at: null }] : []),
      ] }
      if (table === 'outreach_reply_senders') return { body: [{ remote_sender_id: sender, sender_address: sender, version: 1 }] }
      if (table === 'outreach_leads' && call.method === 'HEAD') return { body: null, headers: { 'content-range': '0-0/1' } }
      throw new Error('Unexpected database read')
    },
    '/workspaces/current': { body: { id: options.providerWorkspace ?? workspace } },
    [`/campaigns/${remote}`]: { body: remoteCampaign(remote) },
    [`/campaigns/${secondRemote}`]: { body: remoteCampaign(secondRemote) },
    '/campaigns/analytics/daily': { body: options.emptyDaily ? [] : [{ date: '2026-10-01', sent: 7, unique_replies: 1 }] },
    '/campaigns/analytics': call => ({ body: options.totals === null ? [] : [{ campaign_id: new URL(call.url).searchParams.get('id'), leads_count: 2, reply_count_unique: 1, ...options.totals }] }),
    '/leads/list': call => {
      const campaign = JSON.parse(call.body!).campaign
      const page = (leadReads.get(campaign) ?? 0) + 1
      leadReads.set(campaign, page)
      return { body: page === 1
        ? { items: [{ id: 'first', campaign, email: 'first@example.test', payload: { title: 'Manager' } }], next_starting_after: 'page-2' }
        : options.secondPage ?? { items: [{ id: 'second', campaign, email: 'second@example.test' }] } }
    },
  })
  t.after(stub.restore)
  return { calls: stub.calls, run: (apply = true) => backfillAssignedCampaigns({ ...manifest,
    campaignIds: options.secondCampaign ? [remote, secondRemote] : manifest.campaignIds }, { apply, delay: async () => {} }) }
}

test('backfill imports assigned result contracts and full lead pages under a renewed lease without touching messages or sync state', async t => {
  const h = harness(t), result = await h.run()
  assert.equal(result.complete, true)
  assert.deepEqual(result.campaigns, [{ campaignId: local, leadPages: 2, leads: 2, skippedLeads: 0, dailyRows: 1, steps: 1 }])
  const writes = tableWrites(h.calls)
  assert.deepEqual([...new Set(writes.map(call => new URL(call.url).pathname.split('/').at(-1)))].sort(),
    ['outreach_campaign_daily', 'outreach_campaign_steps', 'outreach_campaigns', 'outreach_leads'])
  const leadRequests = h.calls.filter(call => call.url.includes('/leads/list'))
  assert.deepEqual(leadRequests.map(call => JSON.parse(call.body!)), [
    { campaign: remote, limit: 100 }, { campaign: remote, limit: 100, starting_after: 'page-2' },
  ])
  const steps = JSON.parse(writes.find(call => call.url.includes('/outreach_campaign_steps'))!.body!)
  assert.equal(steps[0].body_text, 'Hello')
  assert.equal(steps[0].delay_days, 2)
  const summary = JSON.parse(writes.find(call => call.url.includes('/outreach_campaigns?'))!.body!)
  assert.equal(summary.totals.unique_replies, 1)
  assert.equal(summary.totals.positive_replies, 1)
  assert.equal(summary.totals.analytics_available, true)
  assert.equal(summary.status, 'completed')
  const leases = h.calls.filter(call => call.url.includes('/acquire_outreach_sync_lock'))
  assert.ok(leases.length >= leadRequests.length + writes.length)
  const tokens = new Set(leases.map(call => JSON.parse(call.body!).p_token))
  assert.equal(tokens.size, 1)
  assert.equal(h.calls.at(-1)?.url.includes('/release_outreach_sync_lock'), true)
  assert.equal(JSON.parse(h.calls.at(-1)!.body!).p_token, [...tokens][0])
  assert.equal(h.calls.some(call => /\/emails|outreach_messages|outreach_sync_state|reserve_outreach_email_request|outreach_fetch_queue/.test(call.url)), false)
})

test('check mode performs no database writes or lease changes', async t => {
  const h = harness(t), result = await h.run(false)
  assert.equal(result.mode, 'check')
  assert.equal(result.complete, true)
  assert.equal(tableWrites(h.calls).length, 0)
  assert.equal(h.calls.some(call => call.url.includes('/rpc/')), false)
})

test('completed metadata from one campaign does not invalidate the remaining campaign assignments', async t => {
  const h = harness(t, { secondCampaign: true }), result = await h.run()
  assert.equal(result.complete, true)
  assert.deepEqual(result.campaigns.map(campaign => campaign.campaignId), [local, secondLocal])
  assert.equal(result.campaigns.reduce((total, campaign) => total + campaign.leads, 0), 4)
  const campaignWrites = tableWrites(h.calls).filter(call => call.url.includes('/outreach_campaigns?'))
  assert.equal(campaignWrites.length, 2)
  assert.equal(campaignWrites.every(call => Boolean(JSON.parse(call.body!).completed_at)), true)
})

test('senderless draft preserves reported results and has no message access', async t => {
  const h = harness(t, { senderlessDraft: true, totals: { total_opportunities: 2 } })
  await h.run()
  const summary = JSON.parse(tableWrites(h.calls).find(call => call.url.includes('/outreach_campaigns?'))!.body!)
  assert.equal(summary.status, 'draft')
  assert.equal(summary.totals.unique_replies, 1)
  assert.equal(summary.totals.opportunities, 2)
  assert.equal(h.calls.some(call => call.url.includes('/emails')), false)
})

test('draft backfill preserves previous totals when analytics are absent and continues importing real leads', async t => {
  const previousTotals = { leads: 118, sent: 26, unique_replies: 3, opportunities: 4, positive_replies: 9, analytics_available: true }
  const h = harness(t, { senderlessDraft: true, totals: null, emptyDaily: true, previousTotals, secondCampaign: true })
  const result = await h.run()
  assert.equal(result.complete, true)
  assert.equal(result.campaigns.length, 2)
  assert.equal(result.campaigns.reduce((count, campaign) => count + campaign.leads, 0), 4)
  const updates = tableWrites(h.calls).filter(call => call.url.includes('/outreach_campaigns?'))
  assert.equal(updates.length, 2)
  for (const update of updates) assert.deepEqual(JSON.parse(update.body!).totals,
    { ...previousTotals, positive_replies: 1, analytics_available: false })
  assert.equal(tableWrites(h.calls).some(call => call.url.includes('/outreach_campaign_daily')), false)
})

test('draft backfill with no previous totals marks analytics unavailable without adding zero-valued measurements', async t => {
  const h = harness(t, { senderlessDraft: true, totals: null })
  assert.equal((await h.run()).complete, true)
  const update = tableWrites(h.calls).find(call => call.url.includes('/outreach_campaigns?'))!
  assert.deepEqual(JSON.parse(update.body!).totals, { analytics_available: false, positive_replies: 1 })
})

for (const [name, options] of Object.entries({
  missing_non_draft: { totals: null },
  foreign_draft: { senderlessDraft: true, totals: { campaign_id: workspace } },
})) test(`backfill still rejects ${name} analytics before result writes`, async t => {
  const h = harness(t, options)
  await assert.rejects(h.run())
  assert.equal(tableWrites(h.calls).length, 0)
})

for (const [name, options] of Object.entries({
  denied_lease: { lease: false },
  foreign_workspace: { providerWorkspace: '55555555-5555-4555-8555-555555555555' },
  foreign_sender: { campaignSender: 'foreign@example.test' },
  unreviewed_assignment: { extraAssignment: true },
  changed_authority: { changedBinding: true },
  lost_lease: { loseLease: true },
})) test(`backfill refuses ${name} before result writes`, async t => {
  const h = harness(t, options)
  await assert.rejects(h.run())
  assert.equal(tableWrites(h.calls).length, 0)
})

for (const [name, secondPage] of Object.entries({
  repeated_cursor: { items: [{ campaign: remote, email: 'second@example.test' }], next_starting_after: 'page-2' },
  foreign_lead: { items: [{ campaign: workspace, email: 'foreign@example.test' }] },
  empty_continuation: { items: [], next_starting_after: 'page-3' },
})) test(`backfill rejects ${name}, releases its lease and leaves prior idempotent writes reusable`, async t => {
  const h = harness(t, { secondPage })
  await assert.rejects(h.run())
  assert.equal(tableWrites(h.calls).filter(call => call.url.includes('/outreach_leads')).length, 1)
  assert.equal(tableWrites(h.calls).some(call => call.url.includes('/outreach_campaigns?')), false)
  assert.equal(h.calls.at(-1)?.url.includes('/release_outreach_sync_lock'), true)
})

test('wrong database target and duplicate manifest IDs fail before network access', async t => {
  const h = harness(t)
  await assert.rejects(backfillAssignedCampaigns({ ...manifest, campaignIds: [remote, remote] }, { apply: true }))
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://stfygrdsjgrmmawvnifc.supabase.co'
  await assert.rejects(h.run())
  assert.equal(h.calls.length, 0)
})
