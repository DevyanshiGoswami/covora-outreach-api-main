import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../../src/lib/database.types.ts'
import { requireOutreachOwner } from '../../src/lib/outreach-owner.ts'

const tenant = 'b5cc0cf8-d817-4aab-a41a-813ac99ccabe'
function client(rows: unknown[], { signedIn = true, failed = false } = {}) {
  const requests: URL[] = []
  const db = createClient<Database>('http://localhost:55321', 'public-fixture-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input) => {
      const url = new URL(String(input)); requests.push(url)
      assert.equal(url.pathname, '/rest/v1/client_outreach_workspaces')
      assert.equal(url.searchParams.get('role'), 'eq.agency_owner')
      return Response.json(failed ? { message: 'private database diagnostic' } : rows, { status: failed ? 500 : 200 })
    } },
  })
  mock.method(db.auth, 'getUser', async () => ({ data: { user: signedIn ? { id: '20c30b40-6360-48b5-96c6-cdd9579ccbe7' } : null }, error: null }))
  return { db, requests }
}

test('legacy assignment operations require an explicit enabled Outbound owner workspace', async () => {
  const { db, requests } = client([{ client_id: tenant, role: 'agency_owner' }])
  assert.deepEqual(await requireOutreachOwner(db, tenant), [tenant])
  assert.equal(requests.find((u) => u.pathname.includes('/rest/'))?.searchParams.get('client_id'), `eq.${tenant}`)
})

test('legacy admin without an Outbound owner grant cannot reach privileged data', async () => {
  const { db } = client([])
  await assert.rejects(requireOutreachOwner(db, tenant), /Outbound agency access is unavailable/)
})

test('denied or failed identity never queries workspace authority', async () => {
  const { db, requests } = client([], { signedIn: false })
  await assert.rejects(requireOutreachOwner(db), /Outbound agency access is unavailable/)
  assert.equal(requests.length, 0)
})

test('owner workspace lookup errors do not expose private diagnostics', async () => {
  const { db } = client([], { failed: true })
  await assert.rejects(requireOutreachOwner(db), { message: 'Outbound agency access is unavailable.' })
})
