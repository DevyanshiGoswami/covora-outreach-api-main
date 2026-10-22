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
test('only explicit PIN-required states expose code entry; connecting and syncing need no code', async () => {
  for (const [status, nextStep] of [['Connecting', 'connecting'], ['Syncing', 'syncing'], ['PinRequired', 'verification_code'], ['PIN required', 'verification_code'], ['AwaitingPin', 'verification_code'], ['AwaitingVerification', 'check_status'], ['FutureStatus', 'check_status']]) {
    assert.deepEqual(await connectAccount(scope, 'poll', { key: 'synthetic', fetch: statusFetch(status) }), { state: 'pending', nextStep })
  }
})
test('PIN submission checks the current account and never posts a code to a non-PIN state', async () => {
  for (const status of ['Connecting', 'Syncing', 'FutureStatus', 'Disconnected']) {
    const calls: string[] = []
    const result = await connectAccount(scope, 'pin', { key: 'synthetic', fetch: async (url, init) => {
      calls.push(String(url)); assert.equal(init?.method, 'GET')
      return Response.json({ accountId: 123, status, profile: { profileUrl: null } })
    } }, { pin: '123456' })
    assert.equal(calls.length, 1)
    assert.equal(result.state, status === 'Disconnected' ? 'failed' : 'pending')
    assert.equal(result.nextStep === 'verification_code', false)
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
      return ++calls === 1 ? Response.json({ accountId: 123, status: 'PinRequired', profile: null }) : new Response(null, { status })
    } }, { pin: '123456' })
    assert.equal(calls, 2)
    assert.equal(result.state, 'pending')
    assert.equal(result.nextStep, status === 400 ? 'verification_code' : 'check_status')
    assert.equal(result.failureCode, status === 400 ? 'linkedin_code_rejected' : status === 409 ? 'linkedin_code_not_requested' : 'linkedin_status_unavailable')
  }
})
