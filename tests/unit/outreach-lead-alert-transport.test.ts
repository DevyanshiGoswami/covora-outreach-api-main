import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLeadAlertTransport } from '../../src/lib/outreach-lead-alert-transport.ts'
import type { LeadAlertDispatch } from '../../src/lib/outreach-lead-alert-worker.ts'

const now = Date.parse('2026-10-04T18:00:00Z')
const environment = {
  ENABLE_OUTREACH_LEAD_ALERT_EMAILS: 'true', RESEND_API_KEY: 're_test_synthetic_only',
  NOTIFY_FROM: 'Covora <alerts@example.test>', OUTREACH_PORTAL_ORIGIN: 'https://outreach.example.test',
  ENABLE_CLIENT_EMAILS: 'false',
}
const delivery: LeadAlertDispatch = {
  id: '33333333-3333-4333-8333-333333333333', claimToken: '44444444-4444-4444-8444-444444444444',
  clientId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222',
  recipientEmail: 'client@example.test', leadCount: 5, expiresAt: new Date(now + 60_000).toISOString(),
}
const accepted = () => Response.json({ id: '55555555-5555-4555-8555-555555555555' })

test('the dedicated alert gate is mandatory even with valid legacy email configuration', async () => {
  for (const flag of [undefined, 'false', 'TRUE', '1']) {
    let calls = 0
    const transport = createLeadAlertTransport({ environment: { ...environment, ENABLE_OUTREACH_LEAD_ALERT_EMAILS: flag, ENABLE_CLIENT_EMAILS: 'true' },
      now: () => now, fetch: async () => { calls++; return accepted() } })
    assert.equal(transport.configured, false)
    assert.deepEqual(await transport.send(delivery), { status: 'failed', errorCode: 'delivery_unconfigured' })
    assert.equal(calls, 0)
  }
})

test('missing or unsafe settings fail closed without a default sender or portal destination', async () => {
  for (const change of [
    { RESEND_API_KEY: '' }, { RESEND_API_KEY: 'bad\nheader' }, { NOTIFY_FROM: '' },
    { NOTIFY_FROM: 'one@example.test,two@example.test' }, { NOTIFY_FROM: 'Covora <one@example.test>\r\nBcc: other@example.test' },
    { NOTIFY_FROM: 'Covora <onboarding@resend.dev>' }, { OUTREACH_PORTAL_ORIGIN: '' },
    { OUTREACH_PORTAL_ORIGIN: 'http://localhost:3001' }, { OUTREACH_PORTAL_ORIGIN: 'https://outreach.example.test/other' },
    { OUTREACH_PORTAL_ORIGIN: 'https://outreach.example.test?other=yes' },
  ]) {
    let calls = 0
    const transport = createLeadAlertTransport({ environment: { ...environment, ...change }, now: () => now,
      fetch: async () => { calls++; return accepted() } })
    assert.equal(transport.configured, false)
    assert.equal((await transport.send(delivery)).status, 'failed')
    assert.equal(calls, 0)
  }
})

test('one current dispatch sends approved HTML and text to its sole recipient with a durable idempotency key', async () => {
  const requests: RequestInit[] = []
  const transport = createLeadAlertTransport({ environment, now: () => now, fetch: async (url, init) => {
    assert.equal(url, 'https://api.resend.com/emails')
    requests.push(init!)
    return accepted()
  } })
  assert.equal(transport.configured, true)
  assert.deepEqual(await transport.send(delivery), { status: 'sent' })
  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error'); assert.equal(request.cache, 'no-store')
  assert.ok(request.signal)
  const headers = new Headers(request.headers)
  assert.equal(headers.get('authorization'), `Bearer ${environment.RESEND_API_KEY}`)
  assert.equal(headers.get('idempotency-key'), `covora-lead-alert/${delivery.id}`)
  const payload = JSON.parse(request.body as string)
  assert.deepEqual(Object.keys(payload).sort(), ['from', 'html', 'subject', 'text', 'to'])
  assert.deepEqual(payload.to, [delivery.recipientEmail])
  assert.equal(payload.from, environment.NOTIFY_FROM)
  assert.equal(payload.subject, 'You have 5 new leads that want to hear from you!')
  assert.match(payload.text, /View your leads: https:\/\/outreach.example.test\/\?client=11111111-1111-4111-8111-111111111111&view=inbox/)
  assert.match(payload.html, /View your leads/)
  assert.equal(JSON.stringify(payload).includes(delivery.claimToken), false)
})

test('malformed or expired dispatches never reach the provider', async () => {
  let calls = 0
  const transport = createLeadAlertTransport({ environment, now: () => now, fetch: async () => { calls++; return accepted() } })
  for (const change of [{ recipientEmail: 'a@example.test,b@example.test' }, { leadCount: 0 },
    { id: 'bad' }, { claimToken: 'bad' }, { userId: 'bad' }, { clientId: 'bad' }, { expiresAt: new Date(now).toISOString() }]) {
    assert.deepEqual(await transport.send({ ...delivery, ...change }), { status: 'failed', errorCode: 'invalid_dispatch' })
  }
  assert.equal(calls, 0)
})

test('explicit validation/auth/rate-limit rejections are terminal and never retried', async () => {
  for (const status of [400, 401, 403, 404, 422, 429]) {
    let calls = 0
    const transport = createLeadAlertTransport({ environment, now: () => now, fetch: async () => {
      calls++; return Response.json({ name: status === 429 ? 'rate_limit_exceeded' : 'validation_error', message: 'private provider detail' }, { status })
    } })
    assert.deepEqual(await transport.send(delivery), { status: 'failed', errorCode: status === 429 ? 'rate_limited' : 'delivery_rejected' })
    assert.equal(calls, 1)
  }
})

test('ambiguous provider responses stay unknown rather than claiming success or releasing deduplication', async () => {
  const responses = [
    () => Response.json({ id: '' }), () => Response.json({ error: 'private' }),
    () => Response.json({ id: '55555555-5555-4555-8555-555555555555', error: 'conflict' }),
    () => new Response('not-json'), () => new Response(null, { status: 204 }),
    () => new Response('redirect', { status: 302 }),
    () => Response.json({ name: 'invalid_idempotent_request', message: 'private' }, { status: 409 }),
    () => Response.json({ name: 'concurrent_idempotent_requests', message: 'private' }, { status: 409 }),
    () => Response.json({ name: 'application_error', message: 'private' }, { status: 500 }),
    () => new Response('down', { status: 503 }), () => new Response('timeout', { status: 408 }),
    () => new Response('rejected without contract', { status: 422 }),
  ]
  for (const response of responses) {
    let calls = 0
    const transport = createLeadAlertTransport({ environment, now: () => now, fetch: async () => { calls++; return response() } })
    assert.deepEqual(await transport.send(delivery), { status: 'unknown', errorCode: 'transport_unknown' })
    assert.equal(calls, 1)
  }
})

test('network failures return neutral unknown outcomes without leaking diagnostics', async () => {
  const transport = createLeadAlertTransport({ environment, now: () => now,
    fetch: async () => { throw new Error(`private ${environment.RESEND_API_KEY} ${delivery.recipientEmail}`) } })
  assert.deepEqual(await transport.send(delivery), { status: 'unknown', errorCode: 'transport_unknown' })
})

test('Resend message IDs are opaque strings and do not require UUID syntax', async () => {
  const transport = createLeadAlertTransport({ environment, now: () => now,
    fetch: async () => Response.json({ id: 'email_opaque_accepted_id' }) })
  assert.deepEqual(await transport.send(delivery), { status: 'sent' })
})

test('the eight-second deadline covers a stalled request and aborts it without retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal: AbortSignal | null | undefined
  let calls = 0
  const transport = createLeadAlertTransport({ environment, now: () => now, fetch: async (_url, init) => {
    calls++; signal = init?.signal
    return new Promise<Response>(() => {})
  } })
  const result = transport.send(delivery)
  t.mock.timers.tick(8000)
  assert.deepEqual(await result, { status: 'unknown', errorCode: 'transport_unknown' })
  assert.equal(calls, 1); assert.equal(signal?.aborted, true)
})

test('the same deadline covers response-body stalls and oversized responses stay unknown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = createLeadAlertTransport({ environment, now: () => now,
    fetch: async () => new Response(new ReadableStream({ start() {} })) })
  const result = transport.send(delivery)
  await Promise.resolve()
  t.mock.timers.tick(8000)
  assert.deepEqual(await result, { status: 'unknown', errorCode: 'transport_unknown' })
  const huge = createLeadAlertTransport({ environment, now: () => now,
    fetch: async () => Response.json({ id: '55555555-5555-4555-8555-555555555555', padding: 'x'.repeat(20_000) }) })
  assert.deepEqual(await huge.send(delivery), { status: 'unknown', errorCode: 'transport_unknown' })
})

test('gate revocation after transport creation prevents a send', async () => {
  const mutable = { ...environment }
  let calls = 0
  const transport = createLeadAlertTransport({ environment: mutable, now: () => now, fetch: async () => { calls++; return accepted() } })
  mutable.ENABLE_OUTREACH_LEAD_ALERT_EMAILS = 'false'
  assert.deepEqual(await transport.send(delivery), { status: 'failed', errorCode: 'delivery_unconfigured' })
  assert.equal(calls, 0)
})
