import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewLinkedinAttempt, type ConnectionContext } from '../../src/lib/onboarding-provider'

const context: ConnectionContext = { channel: 'linkedin', email: 'person@example.test', workspace: 'w', credential: 'OUTREACH_HEYREACH_TEST', remoteSession: null, remoteAccount: null }
function heyreach(routes: Record<string, () => Response>, calls: string[] = []): typeof fetch {
  return async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${new URL(String(url)).pathname.replace('/api/public', '')}`
    calls.push(key)
    const route = Object.entries(routes).find(([pattern]) => key.startsWith(pattern))
    if (!route) throw new Error(`Unexpected ${key}`)
    return route[1]()
  }
}
const list = (items: { id: number; emailAddress?: string | null }[]) => () => Response.json({ totalCount: items.length, items })

test('a stuck attempt with a known sender is restored only after a read-only status check', async () => {
  const calls: string[] = []
  assert.deepEqual(await reviewLinkedinAttempt({ ...context, remoteAccount: '42' }, { key: 'k', fetch: heyreach({
    'GET /li_account/GetAccountStatus/42': () => Response.json({ accountId: 42, status: 'Challenged', failureReason: 'Verification required', profile: null }),
  }, calls) }), { outcome: 'restore', remoteAccount: '42' })
  assert.deepEqual(calls, ['GET /li_account/GetAccountStatus/42'])
})

test('failed or mismatched known senders cannot be restored, replaced or deleted by review', async t => {
  t.mock.method(console, 'warn', () => {})
  for (const observation of [
    Response.json({ accountId: 42, status: 'Disconnected' }),
    Response.json({ accountId: 42, status: 'Failed' }),
    Response.json({ accountId: 43, status: 'Challenged' }),
    Response.json({ accountId: 42, status: 'Connected', profile: { profileUrl: 'https://www.linkedin.com/in/other-person' } }),
    new Response(null, { status: 503 }),
  ]) {
    const calls: string[] = []
    assert.deepEqual(await reviewLinkedinAttempt({ ...context, remoteAccount: '42', expectedProfileUrl: 'https://www.linkedin.com/in/test-person' },
      { key: 'k', fetch: heyreach({ 'GET /li_account/GetAccountStatus/42': () => observation }, calls) }), { outcome: 'unavailable' })
    assert.deepEqual(calls, ['GET /li_account/GetAccountStatus/42'])
  }
})

test('ambiguous sender matches remain unresolved instead of choosing an account', async () => {
  const fetch = heyreach({ 'POST /li_account/GetAll': list([{ id: 7, emailAddress: 'PERSON@example.test' }, { id: 9, emailAddress: 'person@example.test' }, { id: 12, emailAddress: 'other@example.test' }]) })
  assert.deepEqual(await reviewLinkedinAttempt(context, { key: 'k', fetch }), { outcome: 'unavailable' })
})

test('no matching sender means the attempt never reached HeyReach; an unreadable list stays unknown', async () => {
  assert.deepEqual(await reviewLinkedinAttempt(context, { key: 'k', fetch: heyreach({ 'POST /li_account/GetAll': list([{ id: 3, emailAddress: null }, { id: 4, emailAddress: 'other@example.test' }]) }) }), { outcome: 'missing' })
  assert.deepEqual(await reviewLinkedinAttempt(context, { key: 'k', fetch: heyreach({ 'POST /li_account/GetAll': () => new Response('down', { status: 503 }) }) }), { outcome: 'unavailable' })
  assert.deepEqual(await reviewLinkedinAttempt(context, { key: 'k', fetch: heyreach({ 'POST /li_account/GetAll': () => Response.json({ totalCount: 150, items: [{ id: 1 }] }) }) }), { outcome: 'unavailable' })
})

test('a unique sender matching the login can be checked without another sign-in', async () => {
  const fetch = heyreach({ 'POST /li_account/GetAll': list([{ id: 9, emailAddress: 'person@example.test' }, { id: 12, emailAddress: 'other@example.test' }]) })
  assert.deepEqual(await reviewLinkedinAttempt(context, { key: 'k', fetch }), { outcome: 'restore', remoteAccount: '9' })
})
