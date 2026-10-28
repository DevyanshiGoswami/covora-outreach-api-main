import assert from 'node:assert/strict'
import test from 'node:test'
import { createOnboardingHandlers } from '../../src/lib/onboarding-api'

const clientId = '10000000-0000-4000-8000-000000000001'
const userId = '20000000-0000-4000-8000-000000000002'
const input = { clientId, name: 'Exact company name' }
function harness(error?: { code: string; message: string }) {
  const calls: Request[] = []
  const handler = createOnboardingHandlers({ url: 'https://database.invalid', anonKey: 'public-key', serviceKey: 'unused-service-key',
    fetch: async (url, init) => {
      const request = new Request(url, init); calls.push(request.clone())
      if (new URL(request.url).pathname === '/auth/v1/user') return Response.json({ id: userId, email: 'owner@example.test' })
      assert.equal(new URL(request.url).pathname, '/rest/v1/rpc/remove_outreach_client')
      assert.equal(request.headers.get('authorization'), 'Bearer user-session')
      assert.deepEqual(await request.json(), { p_client_id: clientId, p_name: input.name })
      return error ? Response.json(error, { status: 400 }) : new Response(null, { status: 204 })
    }, providerFetch: async () => { throw new Error('No provider calls allowed') },
  }).removeClient
  const request = (body: unknown = input, authorized = true, query = '') => new Request(`http://localhost/api/onboarding/clients/remove${query}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer user-session' } : {}) }, body: JSON.stringify(body),
  })
  return { handler, request, calls }
}
test('removal verifies a bearer, rejects malformed bodies and binds the RPC to that session', async () => {
  const h = harness()
  assert.equal((await h.handler(h.request(input, false))).status, 401)
  assert.equal(h.calls.length, 0)
  for (const body of [{ ...input, clientId: 'invalid' }, { ...input, name: '' }, { ...input, actorId: userId }]) {
    assert.equal((await h.handler(h.request(body))).status, 400)
  }
  assert.equal((await h.handler(h.request(input, true, '?clientId=other'))).status, 400)
  assert.ok(h.calls.every(call => new URL(call.url).pathname === '/auth/v1/user'))
  const response = await h.handler(h.request())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { ok: true })
})
test('removal returns safe errors for denied roles, mismatched names and in-flight replies', async () => {
  for (const [code, status] of [['42501', 403], ['22023', 400], ['55000', 409], ['unexpected', 500]] as const) {
    const h = harness({ code, message: 'PRIVATE DATABASE DIAGNOSTIC' })
    const response = await h.handler(h.request())
    assert.equal(response.status, status)
    assert.ok(!(await response.text()).includes('PRIVATE DATABASE DIAGNOSTIC'))
  }
})
