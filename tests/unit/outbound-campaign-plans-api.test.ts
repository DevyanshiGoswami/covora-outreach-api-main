import assert from 'node:assert/strict'
import test from 'node:test'
import { createOutboundCampaignPlanHandlers } from '../../src/lib/outbound-campaign-plans-api.ts'
import { createOutboundLeadHandlers } from '../../src/lib/outbound-leads-api.ts'

const clientId = 'c5ddfa59-1551-4688-a381-10d94107140f'
const id = '9d375705-20e1-4c5e-a0af-be175888827f'
const plan = { id, name: 'Manufacturer LinkedIn', audience: 'hiring_partners', channel: 'linkedin', status: 'draft', leadCount: 0, createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z' }
const user = { id: clientId, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, identities: [], created_at: plan.createdAt }
function harness(result: unknown = { campaigns: [plan] }, status = 200) {
  const calls: { path: string; body: unknown; auth: string | null }[] = []
  const config = { url: 'https://db.invalid', anonKey: 'public-key', fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname, body = await request.text()
    calls.push({ path, body: body ? JSON.parse(body) : null, auth: request.headers.get('authorization') })
    return Response.json(path === '/auth/v1/user' ? user : result, { status: path === '/auth/v1/user' ? 200 : status })
  } }
  return { calls, plans: createOutboundCampaignPlanHandlers(config), leads: createOutboundLeadHandlers(config) }
}
const request = (query = `clientId=${clientId}`, token = 'Bearer synthetic-token') => new Request(`https://api.invalid/api/outbound/campaign-plans?${query}`, { headers: { authorization: token } })

test('native plan list verifies identity and exposes only neutral draft fields', async () => {
  const h = harness({ campaigns: [{ ...plan, provider_campaign_id: 'hidden' }], secret: 'hidden' })
  const response = await h.plans.GET(request())
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { campaigns: [plan] })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(h.calls.map(call => call.path), ['/auth/v1/user', '/rest/v1/rpc/list_outreach_campaign_plans'])
  assert.deepEqual(h.calls[1].body, { p_client_id: clientId })
  assert.ok(h.calls.every(call => call.auth === 'Bearer synthetic-token'))
  assert.deepEqual(Object.keys(h.plans), ['GET'])
})

test('invalid requests and unsupported activation metadata fail closed', async () => {
  for (const query of ['', 'clientId=bad', `clientId=${clientId}&clientId=${clientId}`, `clientId=${clientId}&status=active`]) {
    const h = harness()
    assert.equal((await h.plans.GET(request(query))).status, 400)
    assert.equal(h.calls.length, 1)
  }
  const unauthorized = harness()
  assert.equal((await unauthorized.plans.GET(request(undefined, ''))).status, 401)
  assert.equal(unauthorized.calls.length, 0)
  for (const campaigns of [[{ ...plan, status: 'active' }], [{ ...plan, audience: 'athletes', channel: 'email' }], [{ ...plan, leadCount: -1 }], [plan, plan]]) {
    const response = await harness({ campaigns }).plans.GET(request())
    assert.equal(response.status, 500)
    assert.doesNotMatch(await response.text(), /provider|Manufacturer/)
  }
  assert.equal((await harness({ code: '42501', message: 'private' }, 400).plans.GET(request())).status, 403)
})

test('plan filter binds to the directory and rejects inconsistent selected plan or roster', async () => {
  const page = { clientId, leads: [], total: 0, page: 1, pageSize: 36, summary: { total: 0, verifiedEmail: 0, withLinkedIn: 0, companies: 0 }, companies: [], campaigns: [], lists: [], filterOptionsTruncated: false, audienceEnabled: false, locationOptions: { states: [], cities: [] }, selectedPlan: plan }
  const h = harness(page)
  assert.equal((await h.leads.GET(request(`clientId=${clientId}&planId=${id}`))).status, 200)
  assert.equal((h.calls[1].body as Record<string, unknown>).p_plan, id)
  for (const selectedPlan of [undefined, null, { ...plan, id: clientId }, { ...plan, leadCount: 1 }]) {
    assert.equal((await harness({ ...page, selectedPlan }).leads.GET(request(`clientId=${clientId}&planId=${id}`))).status, 500)
  }
  assert.equal((await harness(page).leads.GET(request())).status, 500)
  assert.equal((await harness().leads.GET(request(`clientId=${clientId}&planId=invalid`))).status, 400)
})
