// Read-only HeyReach access check against the saved LinkedIn connection on the isolated local stack:
// npm run provider:probe. It never logs in, connects or creates anything.
import { loadEnvFile } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/lib/database.types'
import { resolveIntegrationCredential } from '../src/lib/integration-credentials'
import { probeLinkedInAccess } from '../src/lib/onboarding-provider'
import { createProviderCallLogger } from '../src/lib/provider-call-log'

async function main() {
  loadEnvFile('.env.test.local')
  const url = process.env.OUTREACH_TEST_SUPABASE_URL
  const serviceKey = process.env.OUTREACH_TEST_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
    throw new Error('Local stack credentials missing. Run npm run test:env first. This probe only uses a local stack.')
  }
  const admin = createClient<Database>(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const saved = await admin.from('outreach_integrations').select('id,label,credential_ref').eq('channel', 'linkedin').order('label').limit(1).maybeSingle()
  if (saved.error || !saved.data) throw new Error('No saved LinkedIn connection found. Add one in Agency workspace → Integrations.')
  const key = await resolveIntegrationCredential(saved.data.credential_ref, {}, admin)
  if (!key) throw new Error('The saved LinkedIn connection key could not be read.')

  console.log(`Probing HeyReach with the saved connection "${saved.data.label}" (read-only)…`)
  const result = await probeLinkedInAccess({ key, log: createProviderCallLogger(admin, { source: 'probe', integrationId: saved.data.id }) })
  console.log(`\nAPI key check:            HTTP ${result.key ?? 'no response'}`)
  console.log(`Account Login API check:  HTTP ${result.accountLogin ?? 'no response'}`)
  console.log(result.key !== 200 ? '\n→ The key itself is not accepted.'
    : result.accountLogin === 403 || result.accountLogin === 401 ? '\n→ The key works, but HeyReach refuses Account Login API endpoints for this workspace. Ask HeyReach to enable it.'
      : '\n→ Account Login API endpoints are reachable; a connection failure is specific to that request (see npm run logs:providers).')
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1) })
