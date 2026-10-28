import assert from 'node:assert/strict'
import { testProjectId } from './stack.ts'

export type TestEnv = { URL: string; ANON: string; SERVICE: string }
let loaded: TestEnv | null = null

/** Database fixtures must never follow a production or pre-existing pilot URL. */
export function loadTestEnv(): TestEnv {
  if (loaded) return loaded
  try { process.loadEnvFile('.env.test.local') } catch { /* Explicit test env also works. */ }
  const URL = process.env.OUTREACH_TEST_SUPABASE_URL
  const ANON = process.env.OUTREACH_TEST_SUPABASE_ANON_KEY
  const SERVICE = process.env.OUTREACH_TEST_SUPABASE_SERVICE_ROLE_KEY
  assert.equal(URL, 'http://127.0.0.1:60321', 'DB tests require the isolated Covora_Outreach_API gateway.')
  assert.ok(ANON && SERVICE, 'Generate local-only .env.test.local from this stack status before DB tests.')
  // Retained worker tests read these standard names; only validated local values
  // enter the test process. They never inherit a cloud database configuration.
  process.env.NEXT_PUBLIC_SUPABASE_URL = URL
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE
  process.env.OUTREACH_SUPABASE_PROJECT_REF = 'local-outreach'
  process.env.OUTREACH_ALERT_TEST_PROJECT = testProjectId
  loaded = { URL, ANON, SERVICE }
  return loaded
}
