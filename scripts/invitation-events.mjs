// Prints recent add-user/invitation steps from a local stack: npm run logs:invitations [-- --limit 50] [-- --failed]
// Reads .env.test.local unless OUTREACH_TEST_SUPABASE_URL and OUTREACH_TEST_SUPABASE_SERVICE_ROLE_KEY are already set.
import { loadEnvFile } from 'node:process'
import { createClient } from '@supabase/supabase-js'

try { loadEnvFile('.env.test.local') } catch { /* Explicit environment also works. */ }
const url = process.env.OUTREACH_TEST_SUPABASE_URL
const serviceKey = process.env.OUTREACH_TEST_SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
  throw new Error('Local stack credentials missing. Run npm run test:env first. This viewer only reads a local stack.')
}
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined }
const limit = Math.min(Math.max(Number(arg('limit') ?? 30) || 30, 1), 500)
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
let query = admin.from('outreach_invitation_events')
  .select('created_at,step,outcome,reason,client_id,invitation_id,actor_user_id,invitee,detail')
  .order('created_at', { ascending: false }).limit(limit)
if (process.argv.includes('--failed')) query = query.eq('outcome', 'failed')
const { data, error } = await query
if (error) throw new Error(`Could not read invitation events (${error.code ?? 'unknown'}). Is migration 0128 applied?`)
if (!data.length) { console.log('No invitation events recorded yet.'); process.exit(0) }
for (const row of data.reverse()) {
  const time = new Date(row.created_at).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'medium' })
  console.log(`${time}  ${row.step.padEnd(7)} ${row.outcome.padEnd(7)} ${row.reason.padEnd(22)} ${row.invitee ?? ''}`)
  if (row.detail) console.log(`    ${row.detail}`)
  if (row.invitation_id) console.log(`    invitation: ${row.invitation_id}`)
}
