import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  getCampaign, getCampaignAnalytics, getCampaignStepAnalytics, getDailyCampaignAnalytics,
  InstantlyError, listCampaignLeadsPage, listCampaigns, listEmails, verifyScopedInstantlyWorkspace,
} from '../../src/lib/instantly.ts'
import { stubFetch, type Routes } from './helpers/fetch.ts'

const scope = { apiKey: 'unit-test-only' }
function setup(t: TestContext, routes: Routes) {
  const stub = stubFetch(routes)
  t.after(stub.restore)
  return stub
}

test('campaign picker follows cursors and terminates on an empty terminal page', async t => {
  const stub = setup(t, { '/campaigns': call => ({ body: call.n === 1
    ? { items: [{ id: 'campaign-a', name: 'A', status: 0 }], next_starting_after: 'cursor-a' }
    : { items: [], next_starting_after: 'cursor-a' } }) })
  assert.equal((await listCampaigns(scope)).length, 1)
  assert.equal(stub.calls.length, 2)
  const query = new URL(stub.calls[1].url).searchParams
  assert.equal(query.get('starting_after'), 'cursor-a')
  assert.equal(query.get('include_ai_sales_agent_campaigns'), 'true')
})

test('campaign picker rejects repeating cursors instead of returning incomplete assignments', async t => {
  const stub = setup(t, { '/campaigns': { body: { items: [{ id: 'a' }], next_starting_after: 'same' } } })
  await assert.rejects(listCampaigns(scope), /pagination did not advance/)
  assert.equal(stub.calls.length, 2)
})

test('single campaign read encodes its id and never includes provider errors in the exception', async t => {
  const stub = setup(t, { '/campaigns/': { status: 400, body: { message: 'private@example.test secret body' } } })
  await assert.rejects(getCampaign('private/id', scope), error => {
    assert.ok(error instanceof InstantlyError)
    assert.equal(error.status, 400)
    assert.doesNotMatch(error.message, /private|secret|example/)
    return true
  })
  assert.match(stub.calls[0].url, /private%2Fid$/)
})

test('analytics reads use campaign_id for daily/steps, id for totals, and preserve empty totals', async t => {
  const stub = setup(t, { '/campaigns/analytics': { body: [] } })
  assert.equal(await getCampaignAnalytics('campaign-a', scope), null)
  await getDailyCampaignAnalytics('campaign-a', '2026-10-01', '2026-10-04', scope)
  await getCampaignStepAnalytics('campaign-a', scope)
  assert.equal(new URL(stub.calls[0].url).searchParams.get('id'), 'campaign-a')
  const daily = new URL(stub.calls[1].url).searchParams
  assert.equal(daily.get('campaign_id'), 'campaign-a')
  assert.equal(daily.get('start_date'), '2026-10-01')
  assert.equal(daily.get('end_date'), '2026-10-04')
  assert.equal(new URL(stub.calls[2].url).searchParams.get('include_opportunities_count'), 'true')
})

for (const [name, body] of Object.entries({ object: {}, null: null, null_item: [null], array_item: [[]], number_item: [7] })) {
  test(`malformed ${name} analytics response is not interpreted as unavailable draft analytics`, async t => {
    setup(t, { '/campaigns/analytics': { body } })
    await assert.rejects(getCampaignAnalytics('campaign-a', scope), /analytics response is invalid/)
  })
}

test('lead list is read-only POST with a durable page cursor and preserves non-email leads', async t => {
  const stub = setup(t, { '/leads/list': call => ({ body: call.n === 1
    ? { items: [{ email: null }], next_starting_after: 'next' }
    : { items: [{ email: null }, { email: 'lead@example.test' }] } }) })
  const page = await listCampaignLeadsPage('campaign-a', 'cursor-a', scope)
  assert.equal(page.items[0].email, null)
  assert.equal(page.next_starting_after, 'next')
  assert.equal(stub.calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(stub.calls[0].body!), { campaign: 'campaign-a', limit: 100, starting_after: 'cursor-a' })
  assert.equal((await listCampaignLeadsPage('campaign-a', 'next', scope)).items.length, 2)
})

test('email pages preserve explicit scope, body, thread and timestamp options without implicit pagination', async t => {
  const stub = setup(t, { '/emails': { body: { items: [], next_starting_after: 'next' } } })
  let attempts = 0
  const result = await listEmails({ ...scope,
    campaignId: 'campaign-a', emailType: 'received', lead: 'lead+test@example.test',
    threadId: 'thread-a', minTimestampCreated: '2026-10-01T00:00:00Z',
    maxTimestampCreated: '2026-10-02T00:00:00Z', startingAfter: 'cursor-a', limit: 5,
    beforeAttempt: async () => { attempts++ },
  })
  assert.equal(attempts, 1)
  assert.equal(stub.calls.length, 1)
  assert.equal(result.next_starting_after, 'next')
  const query = new URL(stub.calls[0].url).searchParams
  assert.equal(query.get('campaign_id'), 'campaign-a')
  assert.equal(query.get('lead'), 'lead+test@example.test')
  assert.equal(query.get('search'), 'thread:thread-a')
  assert.equal(query.get('email_type'), 'received')
  assert.equal(query.get('preview_only'), 'false')
  assert.equal(query.get('latest_of_thread'), 'false')
  assert.equal(query.get('mode'), 'emode_all')
  assert.equal(query.get('sort_order'), 'desc')
  assert.equal(query.get('starting_after'), 'cursor-a')
  assert.equal(query.get('min_timestamp_created'), '2026-10-01T00:00:00Z')
  assert.equal(query.get('max_timestamp_created'), '2026-10-02T00:00:00Z')
})

test('a denied email budget issues no request and preserves the worker sentinel', async t => {
  const stub = setup(t, { '/emails': { body: { items: [] } } })
  const sentinel = new Error('workspace budget exhausted')
  await assert.rejects(listEmails({ ...scope, campaignId: 'a', beforeAttempt: async () => { throw sentinel } }), error => error === sentinel)
  assert.equal(stub.calls.length, 0)
})

test('429 retry reserves a new budget slot before making another physical request', async t => {
  const stub = setup(t, { '/emails': { status: 429, body: {} } })
  const sentinel = new Error('second slot denied')
  let attempts = 0
  await assert.rejects(listEmails({ ...scope, campaignId: 'a', beforeAttempt: async () => {
    attempts++
    if (attempts === 2) throw sentinel
  } }), error => error === sentinel)
  assert.equal(attempts, 2)
  assert.equal(stub.calls.length, 1)
})

test('expired deadline and invalid page size fail before consuming email budget', async t => {
  const stub = setup(t, { '/emails': { body: { items: [] } } })
  let attempts = 0
  const beforeAttempt = async () => { attempts++ }
  await assert.rejects(listEmails({ ...scope, campaignId: 'a', deadline: Date.now() - 1, beforeAttempt }), /deadline/)
  await assert.rejects(listEmails({ ...scope, campaignId: 'a', limit: 101, beforeAttempt }), /page limit/)
  assert.equal(attempts, 0)
  assert.equal(stub.calls.length, 0)
})

test('a near deadline prevents 429 backoff from extending beyond the cron tick', async t => {
  const stub = setup(t, { '/emails': { status: 429, body: {} } })
  await assert.rejects(listEmails({ ...scope, campaignId: 'a', deadline: Date.now() + 500, beforeAttempt: async () => {} }), /deadline/)
  assert.equal(stub.calls.length, 1)
})

test('dedicated history credentials reach every read endpoint and never fall back when empty',async t=>{
 const old=globalThis.fetch,legacy=process.env.INSTANTLY_API_KEY
 const keys:string[]=[]
 process.env.INSTANTLY_API_KEY='wrong-legacy-key'
 globalThis.fetch=async(input,init)=>{const r=new Request(input,init);keys.push(r.headers.get('authorization')!);return Response.json(r.url.includes('/analytics')?[]:{items:[]})}
 t.after(()=>{globalThis.fetch=old;if(legacy===undefined)delete process.env.INSTANTLY_API_KEY;else process.env.INSTANTLY_API_KEY=legacy})
 const options={apiKey:'dedicated-key',deadline:Date.now()+10000}
 await getCampaign('campaign',options);await getCampaignAnalytics('campaign',options)
 await getDailyCampaignAnalytics('campaign',undefined,undefined,options);await getCampaignStepAnalytics('campaign',options)
 await listCampaignLeadsPage('campaign',undefined,options)
 await listEmails({ ...scope,...options,campaignId:'campaign',beforeAttempt:async()=>{}})
 assert.deepEqual(keys,Array(6).fill('Bearer dedicated-key'))
 await assert.rejects(getCampaign('campaign',{apiKey:''}));await assert.rejects(getCampaign('campaign'));assert.equal(keys.length,6)
})

test('dedicated history verifies exact current workspace before exposing any campaign data',async()=>{
 const id='11111111-1111-4111-8111-111111111111';let calls=0
 const options={apiKey:'dedicated-key',fetch:async(input:RequestInfo|URL,init?:RequestInit)=>{calls++;const r=new Request(input,init);assert.equal(r.url,'https://api.instantly.ai/api/v2/workspaces/current');assert.equal(r.redirect,'error');return Response.json({id})}}
 assert.equal(await verifyScopedInstantlyWorkspace(id,options),true)
 assert.equal(await verifyScopedInstantlyWorkspace('22222222-2222-4222-8222-222222222222',options),false)
 assert.equal(calls,2)
})
