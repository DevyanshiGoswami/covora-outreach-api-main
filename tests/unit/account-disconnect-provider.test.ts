import assert from 'node:assert/strict'
import test from 'node:test'
import { disconnectAccount, type ConnectionContext } from '../../src/lib/onboarding-provider'
const workspace = '00000000-0000-4000-8000-000000000001'
const email = 'sender@example.test'
const scope: ConnectionContext = { channel: 'email', email, workspace, credential: 'unused', remoteSession: null, remoteAccount: email }
const account = { email, organization: workspace, is_managed_account: false }
const missing = () => Response.json({}, { status: 404 })
function stub(values: (unknown | Response | Error)[]) {
  const calls: { path: string; method: string }[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ path: url.pathname + url.search, method: init?.method ?? 'GET' })
    assert.ok(values.length, 'Unexpected request'); const value = values.shift(); if (value instanceof Error) throw value
    return value instanceof Response ? value : Response.json(value)
  }
  return { calls, fetcher }
}
test('email removal checks workspace, identity, campaigns and then confirms absence', async () => {
  const s = stub([{ id: workspace }, account, { items: [] }, new Response(null, { status: 204 }), missing()])
  assert.deepEqual(await disconnectAccount(scope, true, { key: 'synthetic', fetch: s.fetcher }), { outcome: 'removed' })
  assert.equal(s.calls.filter(c => c.method === 'DELETE').length, 1)
  assert.equal(s.calls[3].path, '/api/v2/accounts/sender%40example.test')
  assert.equal(s.calls[4].method, 'GET')
})
test('campaign assignments, foreign identities and managed mailboxes prevent deletion', async () => {
  for (const responses of [[{ id: workspace }, account, { items: [{ campaign_id: 'any' }] }], [{ id: workspace }, { ...account, email: 'other@example.test' }], [{ id: workspace }, { ...account, is_managed_account: true }], [{ id: '00000000-0000-4000-8000-000000000002' }]]) {
    const s=stub(responses); assert.equal((await disconnectAccount(scope,true,{key:'synthetic',fetch:s.fetcher})).outcome,'rejected')
    assert.equal(s.calls.some(c=>c.method==='DELETE'),false)
  }
})
test('LinkedIn uses the exact saved account and never force-removes campaign assignments', async () => {
  const linked={...scope,channel:'linkedin' as const,remoteAccount:'123'}
  const s=stub([new Response(null,{status:204}),{id:123,emailAddress:email,activeCampaigns:0},new Response('true'),missing()])
  assert.equal((await disconnectAccount(linked,true,{key:'synthetic',fetch:s.fetcher})).outcome,'removed')
  assert.equal(s.calls[2].path,'/api/public/li_account/RemoveAccount/123?force=false')
  assert.equal(s.calls[2].method,'DELETE')
  for(const account of [{id:123,emailAddress:email,activeCampaigns:1},{id:456,emailAddress:email,activeCampaigns:0},{id:123,emailAddress:'other@example.test',activeCampaigns:0}]) {
    const s=stub([new Response(null,{status:204}),account]);assert.equal((await disconnectAccount(linked,true,{key:'synthetic',fetch:s.fetcher})).outcome,'rejected');assert.equal(s.calls.some(c=>c.method==='DELETE'),false)
  }
})
test('a timeout after DELETE is uncertain and subsequent checks never delete', async () => {
  const s=stub([{id:workspace},account,{items:[]},new Error('network unavailable')])
  assert.equal((await disconnectAccount(scope,true,{key:'synthetic',fetch:s.fetcher})).outcome,'uncertain')
  for(const [observation,outcome] of [[missing(),'removed'],[account,'uncertain']] as const) {
    const s=stub([{id:workspace},observation]);assert.equal((await disconnectAccount(scope,false,{key:'synthetic',fetch:s.fetcher})).outcome,outcome)
    assert.equal(s.calls.some(c=>c.method==='DELETE'),false)
  }
})
test('a successful DELETE followed by denied verification cannot become retryable', async () => {
  const s=stub([{id:workspace},account,{items:[]},new Response(null,{status:204}),new Response('',{status:403})])
  assert.equal((await disconnectAccount(scope,true,{key:'synthetic',fetch:s.fetcher})).outcome,'uncertain')
})
test('permission rejection is actionable, secret-free and does not claim removal', async () => {
  const s=stub([{id:workspace},account,{items:[]},Response.json({message:'Invalid scope. Required: accounts:delete. secret-value'},{status:401})])
  assert.deepEqual(await disconnectAccount(scope,true,{key:'synthetic',fetch:s.fetcher}),{outcome:'rejected',failureCode:'disconnect_access_denied'})
})
