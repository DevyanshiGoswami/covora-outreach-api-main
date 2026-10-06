import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const destination = path.join(root, '.env.test.local')
const temporary = destination + '.' + randomUUID() + '.tmp'

try {
  assert.equal(process.argv.length, 2, 'Local test environment accepts no target overrides.')
  const config = readFileSync(path.join(root, 'supabase', 'config.toml'), 'utf8')
  assert.equal(config.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1], 'Covora_Outreach_API')
  // Status includes keys, so neither CLI stdout nor stderr may reach the terminal.
  const raw = execFileSync(path.join(root, 'node_modules', '.bin', 'supabase'), ['status', '--output', 'json'], {
    cwd: root, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const status = JSON.parse(raw)
  assert.equal(status.API_URL, 'http://127.0.0.1:60321')
  const db = new URL(status.DB_URL)
  assert.equal(db.hostname, '127.0.0.1')
  assert.equal(db.port, '60322')
  for (const key of ['ANON_KEY', 'SERVICE_ROLE_KEY']) {
    assert.equal(typeof status[key], 'string')
    assert.match(status[key], /^[A-Za-z0-9._-]+$/)
  }
  const body = '# Generated only from the isolated local Covora_Outreach_API stack.\n'
    + `OUTREACH_TEST_SUPABASE_URL=${status.API_URL}\n`
    + `OUTREACH_TEST_SUPABASE_ANON_KEY=${status.ANON_KEY}\n`
    + `OUTREACH_TEST_SUPABASE_SERVICE_ROLE_KEY=${status.SERVICE_ROLE_KEY}\n`
  writeFileSync(temporary, body, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, destination)
  console.log('Wrote isolated local DB test configuration with private file permissions.')
} catch {
  rmSync(temporary, { force: true })
  console.error('Refused unverified local stack, invalid local keys or target override; existing test configuration was preserved.')
  process.exitCode = 1
}
