import assert from 'node:assert/strict'
import test from 'node:test'
import { runCronWorker } from '../../src/lib/cron-worker.ts'

test('cron authentication and default-off gates do not execute work or touch any database', async t => {
  const previous = { secret: process.env.CRON_SECRET, sync: process.env.OUTREACH_SYNC_ENABLED, alerts: process.env.ENABLE_OUTREACH_LEAD_ALERT_EMAILS }
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('No network expected') }
  process.env.CRON_SECRET = 'synthetic-cron-secret'
  delete process.env.OUTREACH_SYNC_ENABLED
  delete process.env.ENABLE_OUTREACH_LEAD_ALERT_EMAILS
  t.after(() => {
    globalThis.fetch = originalFetch
    for (const [name, value] of Object.entries({ CRON_SECRET: previous.secret, OUTREACH_SYNC_ENABLED: previous.sync, ENABLE_OUTREACH_LEAD_ALERT_EMAILS: previous.alerts })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  })
  const run = async () => { calls++; return { failed: 0 } }
  assert.equal((await runCronWorker(new Request('https://api.example.test'), { name: 'outreach-sync', run })).status, 401)
  for (const name of ['outreach-sync', 'outreach-lead-alerts'] as const) {
    const response = await runCronWorker(new Request('https://api.example.test', { headers: { authorization: 'Bearer synthetic-cron-secret' } }), { name, run })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { worker: name, ok: true, disabled: true })
  }
  assert.equal(calls, 0)
})

test('a mistakenly configured legacy target cannot start an enabled worker', async t => {
  const changes = { CRON_SECRET: 'fixture', OUTREACH_SYNC_ENABLED: 'true', NEXT_PUBLIC_SUPABASE_URL: 'https://stfygrdsjgrmmawvnifc.supabase.co', OUTREACH_SUPABASE_PROJECT_REF: 'stfygrdsjgrmmawvnifc', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fixture', SUPABASE_SERVICE_ROLE_KEY: 'fixture' }
  const previous = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]))
  Object.assign(process.env, changes)
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } })
  let ran = false
  const response = await runCronWorker(new Request('https://api.example.test', { headers: { authorization: 'Bearer fixture' } }), { name: 'outreach-sync', run: async () => { ran = true; return {} } })
  assert.equal(response.status, 503)
  assert.equal(ran, false)
  assert.doesNotMatch(JSON.stringify(await response.json()), /stfygr|fixture/)
})
