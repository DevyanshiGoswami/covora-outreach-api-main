import assert from 'node:assert/strict'
import test from 'node:test'
import { databaseTargetAllowed, runtimeConfiguration } from '../../src/lib/runtime-config.ts'
import { configurationHealth } from '../../src/lib/health.ts'

const project = 'abcdefghijklmnopqrst'
test('the dedicated project pin rejects the content portal, mismatches and ambiguous URLs', () => {
  assert.equal(databaseTargetAllowed(`https://${project}.supabase.co`, project, true), true)
  for (const [url, ref] of [
    ['https://stfygrdsjgrmmawvnifc.supabase.co', project],
    ['https://stfygrdsjgrmmawvnifc.supabase.co', 'stfygrdsjgrmmawvnifc'],
    [`https://${project}.supabase.co`, 'zyxwvutsrqponmlkjihg'],
    [`https://${project}.supabase.co?other=1`, project],
    [`https://user:secret@${project}.supabase.co`, project],
    [`http://${project}.supabase.co`, project],
    [`https://${project}.supabase.co/other`, project],
    [`https://${project}.supabase.co.evil.test`, project],
    [`https://${project}.supabase.co`, ''],
  ]) assert.equal(databaseTargetAllowed(url, ref, true), false)
})

test('only the independent local stack is accepted outside production', () => {
  assert.equal(databaseTargetAllowed('http://127.0.0.1:60321', 'local-outreach'), true)
  assert.equal(databaseTargetAllowed('http://localhost:60321', 'local-outreach'), true)
  for (const port of [54321, 55321, 56321, 58321]) {
    assert.equal(databaseTargetAllowed(`http://localhost:${port}`, 'local-outreach'), false)
  }
  assert.equal(databaseTargetAllowed('http://localhost:60321', 'local-outreach', true), false)
})

test('all provider automation gates require explicit true and configuration health leaks no credentials', () => {
  for (const value of [undefined, 'false', '1', 'TRUE', ' true ']) {
    const env = { OUTREACH_REPLIES_ENABLED: value, OUTREACH_SYNC_ENABLED: value, ENABLE_OUTREACH_LEAD_ALERT_EMAILS: value }
    const result = runtimeConfiguration(env)
    assert.equal(result.repliesEnabled, false)
    assert.equal(result.syncEnabled, false)
    assert.equal(result.alertsEnabled, false)
  }
  const health = configurationHealth({
    NEXT_PUBLIC_SUPABASE_URL: `https://${project}.supabase.co`, OUTREACH_SUPABASE_PROJECT_REF: project,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'secret-public-fixture', SUPABASE_SERVICE_ROLE_KEY: 'secret-service-fixture',
  })
  assert.equal(health.ready, true)
  assert.equal(health.check, 'configuration')
  assert.equal(health.sendingEnabled, false)
  assert.doesNotMatch(JSON.stringify(health), /secret|abcdefghijklmnopqrst/)
  assert.equal(configurationHealth({}).ready, false)
})
