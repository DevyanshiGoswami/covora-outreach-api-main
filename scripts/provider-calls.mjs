// Prints recent provider calls from the isolated local stack: npm run logs:providers [-- --limit 50] [-- --connection <uuid>]
import { loadEnvFile } from 'node:process'
import { createClient } from '@supabase/supabase-js'

loadEnvFile('.env.test.local')
const url = process.env.OUTREACH_TEST_SUPABASE_URL
const serviceKey = process.env.OUTREACH_TEST_SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
  throw new Error('Local stack credentials missing. Run npm run test:env first. This viewer only reads a local stack.')
}
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined }
const limit = Math.min(Math.max(Number(arg('limit') ?? 20) || 20, 1), 500)
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
let query = admin.from('outreach_provider_calls')
  .select('created_at,source,connection_id,channel,method,operation,http_status,outcome,duration_ms,request_id,error_excerpt')
  .order('created_at', { ascending: false }).limit(limit)
if (arg('connection')) query = query.eq('connection_id', arg('connection'))
const { data, error } = await query
if (error) throw new Error(`Could not read provider calls (${error.code ?? 'unknown'}). Is migration 0124 applied?`)
if (!data.length) { console.log('No provider calls recorded yet.'); process.exit(0) }
for (const row of data.reverse()) {
  const time = new Date(row.created_at).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'medium' })
  console.log(`${time}  ${row.channel.padEnd(8)} ${row.method.padEnd(4)} ${row.operation.padEnd(38)} ${String(row.http_status ?? '---').padEnd(4)} ${row.outcome.padEnd(13)} ${String(row.duration_ms).padStart(5)}ms  ${row.source}`)
  if (row.request_id) console.log(`    request id: ${row.request_id}`)
  if (row.error_excerpt) console.log(`    provider said: ${row.error_excerpt}`)
  if (row.connection_id) console.log(`    connection: ${row.connection_id}`)
}
