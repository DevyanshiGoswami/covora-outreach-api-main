import assert from 'node:assert/strict'
import test from 'node:test'
import { createOutboundLeadHandlers } from '../../src/lib/outbound-leads-api.ts'

const CLIENT = 'c5ddfa59-1551-4688-a381-10d94107140f'
const USER = 'f0d5c941-2898-4f66-a7bb-51e68443517e'
const CAMPAIGN = '6f432aad-8d70-4585-adc3-a272925d8b90'
const LEAD = '9d375705-20e1-4c5e-a0af-be175888827f'
const JWT = 'synthetic-user-token'
const user = { id: USER, aud: 'authenticated', role: 'authenticated', email: 'member@example.test', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-10-03T00:00:00Z' }
const lead = { id: LEAD, clientId: CLIENT, campaignId: CAMPAIGN, campaignName: 'Campaign', listId: null, listName: null, firstName: 'Jane', lastName: 'Sample', fullName: 'Jane Sample', company: 'Acme', jobTitle: 'CEO', location: null, email: 'jane@example.test', emailVerification: 'unknown', linkedinUrl: null, linkedinVerified: null, status: 'in_sequence', interest: null, lastActivityAt: null }
const page = { clientId: CLIENT, leads: [lead], total: 1, page: 1, pageSize: 36, summary: { total: 1, verifiedEmail: 0, withLinkedIn: 0, companies: 1 }, companies: ['Acme'], campaigns: [{ id: CAMPAIGN, name: 'Campaign' }], lists: [], filterOptionsTruncated: false }
function request(query = `clientId=${CLIENT}`, authorization = `Bearer ${JWT}`) {
  return new Request(`https://backend.invalid/api/outbound/leads?${query}`, { headers: { authorization, cookie: 'ignored' } })
}
function harness(result: unknown = page, code = 200, authStatus = 200) {
  const calls: { path: string; headers: Headers; body: string; cache: RequestCache }[] = []
  const handlers = createOutboundLeadHandlers({ url: 'https://db.invalid', anonKey: 'public-key', fetch: async (input, init) => {
    const req = new Request(input, init)
    const path = new URL(req.url).pathname
    calls.push({ path, headers: req.headers, body: await req.text(), cache: req.cache })
    if (path === '/auth/v1/user') return Response.json(authStatus === 200 ? user : { error: 'private auth diagnostics' }, { status: authStatus })
    assert.equal(path, '/rest/v1/rpc/list_outreach_leads')
    return Response.json(result, { status: code })
  } })
  return { handlers, calls }
}

test('lead directory verifies bearer and binds the RPC to the same identity; private data is projected away', async () => {
  const { handlers, calls } = harness({ ...page, secret: 'secret', leads: [{ ...lead, provider_lead_id: 'hidden' }] })
  const response = await handlers.GET(request())
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), page)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('vary'), 'Authorization')
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  assert.deepEqual(calls.map(call => call.path), ['/auth/v1/user', '/rest/v1/rpc/list_outreach_leads'])
  for (const call of calls) {
    assert.equal(call.headers.get('authorization'), `Bearer ${JWT}`)
    assert.equal(call.headers.get('apikey'), 'public-key')
    assert.equal(call.cache, 'no-store')
  }
  assert.deepEqual(JSON.parse(calls[1].body), { p_client_id: CLIENT, p_q: '', p_role: 'all', p_company: '', p_email: 'all', p_linkedin: 'all', p_status: 'all', p_sort: 'company', p_page: 1 })
})

test('auth denial and invalid filter requests never read leads; duplicate/unknown keys and malformed pages fail closed', async () => {
  for (const token of ['', 'Basic credential', 'Bearer one two']) {
    const { handlers, calls } = harness()
    assert.equal((await handlers.GET(request(undefined, token))).status, 401)
    assert.equal(calls.length, 0)
  }
  const denied = harness(undefined, 200, 401)
  assert.equal((await denied.handlers.GET(request())).status, 401)
  assert.equal(denied.calls.length, 1)
  for (const q of ['', `clientId=wrong`, `clientId=${CLIENT}&clientId=${CLIENT}`, `clientId=${CLIENT}&provider_id=secret`, ...['0', '-1', '1.5', '01', '1e3', '1000001', 'Infinity', ''].map(value => `clientId=${CLIENT}&page=${value}`), `clientId=${CLIENT}&q=${'a'.repeat(201)}`, `clientId=${CLIENT}&role=executive`, `clientId=${CLIENT}&email=true`, `clientId=${CLIENT}&linkedin=true`, `clientId=${CLIENT}&status=in_sequence`, `clientId=${CLIENT}&sort=unknown`, `clientId=${CLIENT}&campaign=invalid`]) {
    const { handlers, calls } = harness()
    assert.equal((await handlers.GET(request(q))).status, 400, q)
    assert.equal(calls.length, 1)
  }
})

test('validated filters pass as bound RPC arguments and excessive pages accept last-page response', async () => {
  const { handlers, calls } = harness()
  const response = await handlers.GET(request(`clientId=${CLIENT}&q=%20Jane%20&role=owners-executives&company=Acme&campaign=${CAMPAIGN}&email=verified&linkedin=available&status=contacted&sort=name&page=1000000`))
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(calls[1].body), { p_client_id: CLIENT, p_q: 'Jane', p_role: 'owners-executives', p_company: 'Acme', p_campaign: CAMPAIGN, p_email: 'verified', p_linkedin: 'available', p_status: 'contacted', p_sort: 'name', p_page: 1000000 })
})

test('unexpected tenant, malformed DTO, inconsistent pagination and unsafe URLs are denied without exposing contents', async () => {
  const badPages = [
    { ...page, clientId: USER }, { ...page, leads: [{ ...lead, clientId: USER }] }, { ...page, pageSize: 100 },
    { ...page, leads: [{ ...lead, linkedinUrl: 'javascript:alert(1)' }] },
    { ...page, leads: [{ ...lead, linkedinVerified: true }] },
    { ...page, leads: [lead, lead] }, { ...page, total: 4 }, { ...page, page: 2 },
    { ...page, campaigns: [page.campaigns[0], page.campaigns[0]] },
    { ...page, summary: { ...page.summary, verifiedEmail: 2 } },
  ]
  for (const value of badPages) {
    const { handlers } = harness(value)
    const response = await handlers.GET(request())
    assert.equal(response.status, 500)
    const body = await response.text()
    assert.doesNotMatch(body, /jane@example|Acme|script|private/)
  }
  const mismatch = harness({ ...page, leads: [{ ...lead, campaignId: USER }] })
  assert.equal((await mismatch.handlers.GET(request(`clientId=${CLIENT}&campaign=${CAMPAIGN}`))).status, 500)
})

test('RPC denied/invalid/unavailable responses return neutral errors; empty workspace is successful', async () => {
  for (const [code, expected] of [['42501', 403], ['22023', 400], ['XX000', 500]] as const) {
    const { handlers } = harness({ code, message: 'private database details' }, 400)
    const response = await handlers.GET(request())
    assert.equal(response.status, expected)
    assert.doesNotMatch(await response.text(), /private database/)
  }
  const { handlers } = harness({ ...page, leads: [], total: 0, summary: { total: 0, verifiedEmail: 0, withLinkedIn: 0, companies: 0 }, companies: [], campaigns: [] })
  assert.equal((await handlers.GET(request())).status, 200)
})

test('imported lead list filters project neutral list identity and reject impossible campaign/list combinations', async () => {
  const listId = '5a3f2313-a651-4c74-ae2f-ec6a0fc8e86c'
  const row = { ...lead, campaignId: null, campaignName: null, listId, listName: 'Imported prospects' }
  const imported = { ...page, leads: [row], campaigns: [], lists: [{ id: listId, name: 'Imported prospects' }] }
  const { handlers,calls } = harness(imported)
  assert.equal((await handlers.GET(request(`clientId=${CLIENT}&list=${listId}`))).status,200)
  assert.equal(JSON.parse(calls[1].body).p_list,listId)
  for (const wrong of [{...row,listId:USER},{...row,listName:null},{...row,campaignId:CAMPAIGN,campaignName:'Live'},{...row,listId:null,listName:null}]) {
    const bad=harness({...imported,leads:[wrong]})
    assert.equal((await bad.handlers.GET(request(`clientId=${CLIENT}&list=${listId}`))).status,500)
  }
  assert.equal((await harness().handlers.GET(request(`clientId=${CLIENT}&list=bad`))).status,400)
})
