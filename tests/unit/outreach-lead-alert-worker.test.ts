import assert from 'node:assert/strict'
import { test } from 'node:test'
import { drainLeadAlerts, type LeadAlertDispatch, type LeadAlertWorkerDependencies } from '../../src/lib/outreach-lead-alert-worker.ts'

const now = Date.parse('2026-10-04T18:00:00Z')
const clientId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const claim: LeadAlertDispatch = { id: '33333333-3333-4333-8333-333333333333', claimToken: '44444444-4444-4444-8444-444444444444', clientId, userId, recipientEmail: 'client@example.com', leadCount: 5, expiresAt: new Date(now + 60_000).toISOString() }

function fixture(overrides: Partial<LeadAlertWorkerDependencies> = {}) {
  const events: string[] = []
  const deps: LeadAlertWorkerDependencies = {
    enabled: true, configured: true, timeLeft: () => 45_000, now: () => now,
    listPolicies: async offset => { if (offset !== 0) return []; events.push('list'); return [{ clientId, userId }] },
    claim: async () => { events.push('claim'); return claim },
    dispatch: async () => { events.push('dispatch'); return claim },
    finish: async (_claim, status, code) => { events.push(`finish:${status}:${code ?? ''}`); return true },
    send: async () => { events.push('send'); return { status: 'sent' } },
    ...overrides,
  }
  return { deps, events }
}

test('disabled alerts and incomplete configuration never claim or send a client email', async () => {
  for (const enabled of [false, true]) {
    const f = fixture({ enabled, configured: false })
    const result = await drainLeadAlerts(f.deps)
    assert.deepEqual(f.events, [])
    assert.equal(result.sent, 0)
    assert.equal(result.failed, enabled ? 1 : 0)
  }
})

test('send only follows a fresh authorized dispatch and records the durable outcome', async () => {
  const f = fixture()
  assert.equal((await drainLeadAlerts(f.deps)).sent, 1)
  assert.deepEqual(f.events, ['list', 'claim', 'dispatch', 'send', 'finish:sent:'])
})

test('a stale recipient or handled lead rejected by dispatch produces no external email', async () => {
  const f = fixture({ dispatch: async () => null })
  const result = await drainLeadAlerts(f.deps)
  assert.equal(result.skipped, 1)
  assert.equal(f.events.includes('send'), false)
})

test('expired dispatch or altered tenant/recipient payload cannot reach the transport', async () => {
  for (const changed of [
    { expiresAt: new Date(now - 1).toISOString() },
    { recipientEmail: 'another@example.com' },
    { clientId: '55555555-5555-4555-8555-555555555555' },
    { leadCount: 0 },
  ]) {
    const f = fixture({ dispatch: async () => ({ ...claim, ...changed }) })
    const result = await drainLeadAlerts(f.deps)
    assert.equal(result.sent, 0)
    assert.equal(result.failed, 1)
    assert.equal(f.events.includes('send'), false)
    assert.ok(f.events.includes('finish:unknown:invalid_dispatch'))
  }
})

test('ambiguous sends are recorded unknown once and are never retried by the worker', async () => {
  let calls = 0
  const f = fixture({ send: async () => { calls++; throw new Error('private remote diagnostic') } })
  const result = await drainLeadAlerts(f.deps)
  assert.equal(calls, 1)
  assert.equal(result.unknown, 1)
  assert.equal(result.failed, 1)
  assert.ok(f.events.includes('finish:unknown:transport_unknown'))
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal(JSON.stringify(result).includes('client@example.com'), false)
})

test('a lost completion acknowledgement is reported as failure without sending again', async () => {
  const f = fixture({ finish: async () => false })
  const result = await drainLeadAlerts(f.deps)
  assert.equal(result.sent, 0)
  assert.equal(result.unknown, 1)
  assert.equal(result.failed, 1)
  assert.equal(f.events.filter(value => value === 'send').length, 1)
})

test('one failing client does not prevent another client from receiving its eligible alert', async () => {
  const other = '55555555-5555-4555-8555-555555555555'
  const policies = [{ clientId: other, userId }, { clientId, userId }]
  const f = fixture({
    listPolicies: async (offset, limit) => policies.slice(offset, offset + limit),
    claim: async policy => { if (policy.clientId === other) throw new Error('private database detail'); return claim },
  })
  const result = await drainLeadAlerts(f.deps)
  assert.equal(result.failed, 1)
  assert.equal(result.sent, 1)
  assert.equal(JSON.stringify(result).includes('private'), false)
})

test('worker respects its deadline before claiming work and scans policies beyond one page', async () => {
  const stopped = fixture({ timeLeft: () => 10_000 })
  assert.equal((await drainLeadAlerts(stopped.deps)).deferred, 1)
  assert.deepEqual(stopped.events, [])
  const offsets: number[] = []
  let claims = 0
  const paged = fixture({
    timeLeft: () => claims < 2 ? 45_000 : 10_000,
    listPolicies: async (offset, limit) => { offsets.push(offset); return Array.from({ length: limit }, () => ({ clientId, userId })) },
    claim: async () => { claims++; return null },
  })
  await drainLeadAlerts(paged.deps)
  assert.deepEqual(offsets, [0, 1])
  assert.equal(claims, 2)
})

test('repeated budget-limited ticks reach every recipient despite a slow failing first policy', async () => {
  const policies = [clientId, '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666']
    .map(id => ({ clientId: id, userId, lastScannedAt: null as number | null }))
  const attempted: string[] = []
  for (let tick = 0; tick < 3; tick++) {
    const tickStart = now + tick * 300_000
    let time = 45_000
    const f = fixture({
      timeLeft: () => time,
      listPolicies: async (_offset, limit) => {
        time -= 8_000
        // Model durable reservation: every returned policy moves to the back
        // of the queue, even if the worker's budget expires before visiting it.
        const selected = policies.filter(policy => policy.lastScannedAt === null || policy.lastScannedAt < tickStart - 60_000)
          .sort((a, b) => (a.lastScannedAt ?? -Infinity) - (b.lastScannedAt ?? -Infinity)
            || a.clientId.localeCompare(b.clientId)).slice(0, limit)
        for (const policy of selected) policy.lastScannedAt = tickStart
        return selected.sort((a, b) => a.clientId.localeCompare(b.clientId))
          .map(({ clientId: selectedClientId, userId: selectedUserId }) => ({ clientId: selectedClientId, userId: selectedUserId }))
      },
      claim: async policy => {
        time -= 8_000
        attempted.push(policy.clientId)
        throw new Error('Synthetic slow claim failure')
      },
    })
    const result = await drainLeadAlerts(f.deps)
    assert.equal(result.checked, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.deferred, 1)
  }
  assert.deepEqual(attempted, policies.map(policy => policy.clientId))
})

test('a slow preparation defers without permanently failing a recipient that has not received email', async () => {
  let time = 40_000
  const f = fixture({ timeLeft: () => time, claim: async () => { time = 26_000; return claim } })
  const result = await drainLeadAlerts(f.deps)
  assert.equal(result.deferred, 1)
  assert.equal(result.failed, 0)
  assert.deepEqual(f.events, ['list'])
})

test('admission reserves enough time for claim, dispatch, send, and durable completion', async () => {
  const f = fixture({ timeLeft: () => 34_000 })
  assert.equal((await drainLeadAlerts(f.deps)).deferred, 1)
  assert.deepEqual(f.events, [])
})

test('bounded eight-second operations complete without an unnecessary unknown outcome', async () => {
  let time = 45_000
  const events: string[] = []
  const tick = (event: string) => { time -= 8_000; events.push(event) }
  const f = fixture({
    timeLeft: () => time,
    listPolicies: async () => { tick('list'); return [{ clientId, userId }] },
    claim: async () => { tick('claim'); return claim },
    dispatch: async () => { tick('dispatch'); return claim },
    send: async () => { tick('send'); return { status: 'sent' } },
    finish: async () => { tick('finish'); return true },
  })
  const result = await drainLeadAlerts(f.deps)
  assert.equal(result.sent, 1)
  assert.equal(result.unknown, 0)
  assert.equal(time, 5_000)
  assert.deepEqual(events, ['list', 'claim', 'dispatch', 'send', 'finish'])
})
