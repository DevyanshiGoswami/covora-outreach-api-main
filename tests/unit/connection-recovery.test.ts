import assert from 'node:assert/strict'
import test from 'node:test'
import { releaseLinkedinSender, reviewLinkedinAttempt, type ConnectionContext } from '../../src/lib/onboarding-provider'

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

test('a stuck attempt with a known sender is restored without any provider call', async () => {
  const calls: string[] = []
  assert.deepEqual(await reviewLinkedinAttempt({ ...context, remoteAccount: '42' }, { key: 'k', fetch: heyreach({}, calls) }), { outcome: 'restore', remoteAccount: '42' })
  assert.deepEqual(calls, [])
})

test('without a known sender, the newest sender with this login email is adopted', async () => {
  const fetch = heyreach({ 'POST /li_account/GetAll': list([{ id: 7, emailAddress: 'PERSON@example.test' }, { id: 9, emailAddress: 'person@example.test' }, { id: 12, emailAddress: 'other@example.test' }]) })
  assert.deepEqual(await reviewLinkedinAttempt(context, { key: 'k', fetch }), { outcome: 'restore', remoteAccount: '9' })
})

test('no matching sender means the attempt never reached HeyReach; an unreadable list stays unknown', async () => {
  assert.deepEqual(await reviewLinkedinAttempt(context, { key: 'k', fetch: heyreach({ 'POST /li_account/GetAll': list([{ id: 3, emailAddress: null }, { id: 4, emailAddress: 'other@example.test' }]) }) }), { outcome: 'missing' })
  assert.deepEqual(await reviewLinkedinAttempt(context, { key: 'k', fetch: heyreach({ 'POST /li_account/GetAll': () => new Response('down', { status: 503 }) }) }), { outcome: 'unavailable' })
  assert.deepEqual(await reviewLinkedinAttempt(context, { key: 'k', fetch: heyreach({ 'POST /li_account/GetAll': () => Response.json({ totalCount: 150, items: [{ id: 1 }] }) }) }), { outcome: 'unavailable' })
})

test('releasing a created sender removes it only when it is in no campaign', async () => {
  const removed: string[] = []
  const routes = (activeCampaigns: number, id = 55) => ({ 'GET /li_account/GetById': () => Response.json({ id, emailAddress: null, activeCampaigns }),
    'DELETE /li_account/RemoveAccount/55': () => { removed.push('55'); return Response.json({}) } })
  assert.equal(await releaseLinkedinSender('55', { key: 'k', fetch: heyreach(routes(0)) }), 'released')
  assert.deepEqual(removed, ['55'])
  assert.equal(await releaseLinkedinSender('55', { key: 'k', fetch: heyreach(routes(2)) }), 'kept')
  assert.equal(await releaseLinkedinSender('55', { key: 'k', fetch: heyreach(routes(0, 56)) }), 'kept')
  assert.deepEqual(removed, ['55'])
})

test('an already removed sender counts as released; errors leave it for the next attempt', async () => {
  const calls: string[] = []
  assert.equal(await releaseLinkedinSender('55', { key: 'k', fetch: heyreach({ 'GET /li_account/GetById': () => Response.json({ errorMessage: 'There is no LinkedIn Sender with provided id.' }, { status: 404 }) }, calls) }), 'released')
  assert.ok(!calls.some(call => call.startsWith('DELETE')))
  assert.equal(await releaseLinkedinSender('55', { key: 'k', fetch: async () => { throw new TypeError('fetch failed') } }), 'unavailable')
  assert.equal(await releaseLinkedinSender('not-an-id', { key: 'k', fetch: heyreach({}) }), 'unavailable')
})
