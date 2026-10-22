import assert from 'node:assert/strict'
import test from 'node:test'
import { connectAccount, type ConnectionContext } from '../../src/lib/onboarding-provider'

const scope: ConnectionContext = { channel: 'linkedin', email: 'person@example.test', workspace: 'test', credential: 'synthetic', remoteSession: null, remoteAccount: '123' }
const statusFetch = (status: string, profile: unknown = { profileUrl: null }): typeof fetch => async () => Response.json({ accountId: 123, status, profile })

test('a disconnected account with a null or incomplete profile leaves pending', async () => {
  for (const profile of [null, {}, { profileUrl: null }, { fullName: null, email: null, profileUrl: null }]) {
    assert.deepEqual(await connectAccount(scope, 'poll', { key: 'synthetic', fetch: statusFetch('Disconnected', profile) }),
      { state: 'failed', failureCode: 'linkedin_disconnected' })
  }
})
test('only explicit PIN-required states automatically request code entry', async () => {
  for (const [status, nextStep] of [['Connecting', 'connecting'], ['Syncing', 'syncing'], ['PinRequired', 'verification_code'], ['PIN required', 'verification_code'], ['AwaitingPin', 'verification_code'], ['Challenged', 'check_status'], ['AwaitingVerification', 'check_status'], ['FutureStatus', 'check_status']]) {
    assert.deepEqual(await connectAccount(scope, 'poll', { key: 'synthetic', fetch: statusFetch(status) }), { state: 'pending', nextStep })
  }
})
test('an explicitly entered code reaches SubmitPin even while status is cached or ambiguous', async () => {
  for (const status of ['Connecting', 'Challenged', 'Syncing', 'FutureStatus', 'PinRequired']) {
    const calls: string[] = []
    const result = await connectAccount(scope, 'pin', { key: 'synthetic', fetch: async (url, init) => {
      calls.push(new URL(String(url)).pathname)
      if (calls.length === 2) {
        assert.equal(init?.method, 'POST')
        assert.deepEqual(JSON.parse(String(init.body)), { accountId: 123, pin: '123456' })
        return new Response(null, { status: 204 })
      }
      assert.equal(init?.method, 'GET')
      return Response.json({ accountId: 123, status, profile: { profileUrl: null } })
    } }, { pin: '123456' })
    assert.deepEqual(calls, ['/api/public/li_account/GetAccountStatus/123', '/api/public/li_account/SubmitPin'])
    assert.deepEqual(result, { state: 'pending', nextStep: 'connecting' })
  }
})
test('a code is never sent for a disconnected, connected, mismatched or failed account', async () => {
  for (const observation of [
    { accountId: 123, status: 'Disconnected' },
    { accountId: 123, status: 'Connected', profile: { profileUrl: 'https://www.linkedin.com/in/test-person' } },
    { accountId: 456, status: 'PinRequired' },
    { accountId: 123, status: 'Connecting', failureReason: 'Failed' },
  ]) {
    let calls = 0
    await connectAccount(scope, 'pin', { key: 'synthetic', fetch: async (_url, init) => {
      calls++; assert.equal(init?.method, 'GET'); return Response.json(observation)
    } }, { pin: '123456' })
    assert.equal(calls, 1)
  }
})
test('malformed or unavailable status stays unresolved with an actionable error, never connected or requesting a code', async t => {
  t.mock.method(console, 'warn', () => {})
  for (const response of [Response.json({ status: 'PinRequired' }), Response.json({ accountId: 123, status: 'Connected', profile: { profileUrl: null } }), new Response(null, { status: 503 })]) {
    assert.deepEqual(await connectAccount(scope, 'poll', { key: 'synthetic', fetch: async () => response }),
      { state: 'pending', nextStep: 'check_status', failureCode: 'linkedin_status_unavailable' })
  }
})
test('PIN rejected or no longer needed is safely recoverable and never retried automatically', async t => {
  t.mock.method(console, 'warn', () => {})
  for (const status of [400, 409, 503]) {
    let calls = 0
    const result = await connectAccount(scope, 'pin', { key: 'synthetic', fetch: async () => {
      return ++calls === 1 ? Response.json({ accountId: 123, status: 'Challenged', profile: null }) : new Response(null, { status })
    } }, { pin: '123456' })
    assert.equal(calls, 2)
    assert.equal(result.state, 'pending')
    assert.equal(result.nextStep, status === 400 ? 'verification_code' : 'check_status')
    assert.equal(result.failureCode, status === 400 ? 'linkedin_code_rejected' : status === 409 ? 'linkedin_code_not_requested' : 'linkedin_status_unavailable')
  }
})
