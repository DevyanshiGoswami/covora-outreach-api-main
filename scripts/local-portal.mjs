import { loadEnvFile } from 'node:process'
import { access, writeFile } from 'node:fs/promises'
import { randomUUID, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

// Explicitly local. Never follows .env.local or a cloud project's credentials.
loadEnvFile('.env.test.local')
const url = process.env.OUTREACH_TEST_SUPABASE_URL
if (url !== 'http://127.0.0.1:60321') throw new Error('Generate the isolated local configuration with npm run test:env first.')
const anonKey = process.env.OUTREACH_TEST_SUPABASE_ANON_KEY
const serviceKey = process.env.OUTREACH_TEST_SUPABASE_SERVICE_ROLE_KEY
if (!anonKey || !serviceKey) throw new Error('Missing local credentials. Run npm run test:env.')
if (process.argv[2] === 'dev') {
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3011'], {
    stdio: 'inherit', env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey, OUTREACH_SUPABASE_PROJECT_REF: 'local-outreach',
      OUTREACH_REPLIES_ENABLED: 'false', OUTREACH_SYNC_ENABLED: 'false', ENABLE_OUTREACH_LEAD_ALERT_EMAILS: 'false' },
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('exit', code => process.exit(code ?? 0))
} else if (process.argv[2] === 'frontend-env') {
  const destination = '../covora-outreach/.env.local'
  await writeFile(destination, `NEXT_PUBLIC_SUPABASE_URL=${url}\nNEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey}\nOUTBOUND_API_ORIGIN=http://127.0.0.1:3011\n`, { mode: 0o600, flag: 'wx' })
  console.log('Created public-only local frontend configuration. Existing files are never overwritten.')
} else if (process.argv[2] === 'setup') {
  const destination = '.onboarding-local.json'
  try { await access(destination); console.log(`Local login already recorded in ${destination}.`); process.exit(0) } catch { /* first run */ }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const email = `admin-${randomUUID().slice(0, 8)}@example.test`
  const password = randomBytes(24).toString('base64url')
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (created.error || !created.data.user) throw new Error('Unable to create local test identity.')
  const userId = created.data.user.id
  const clientId = randomUUID()
  try {
    for (const result of [
      await admin.from('outreach_agency_memberships').insert({ user_id: userId, role: 'owner', state: 'active' }),
      await admin.from('clients').insert({ id: clientId, name: 'Covora · Local demo', slug: `local-demo-${clientId}` }),
      await admin.from('client_features').insert({ client_id: clientId, feature: 'outreach_app', enabled: true }),
    ]) if (result.error) throw new Error('Unable to initialize the local workspace.')
    await writeFile(destination, JSON.stringify({ url: 'http://127.0.0.1:3001', email, password, userId, clientId }, null, 2)+'\n', { mode: 0o600, flag: 'wx' })
    console.log(`Created a synthetic local agency owner. Login details are in ${destination} (gitignored, private permissions).`)
  } catch (error) {
    await admin.from('clients').delete().eq('id', clientId)
    await admin.auth.admin.deleteUser(userId)
    throw error
  }
} else throw new Error('Use setup, dev, or frontend-env.')
