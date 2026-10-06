import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = path.join(root, 'node_modules', '.bin', 'supabase')
const destination = path.join(root, 'src', 'lib', 'database.types.ts')
const temporary = destination + '.' + randomUUID() + '.tmp'

function run(args) {
  try {
    return execFileSync(cli, args, { cwd: root, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    throw new Error('Local schema type generation failed; the existing generated file was preserved.')
  }
}

try {
  assert.equal(process.argv.length, 2, 'Type generation accepts no cloud/project override arguments.')
  const config = readFileSync(path.join(root, 'supabase', 'config.toml'), 'utf8')
  assert.equal(config.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1], 'Covora_Outreach_API')
  // Capture CLI status privately: its local keys must never be printed or saved
  // alongside the generated schema. --local cannot follow a remote project link.
  const status = JSON.parse(run(['status', '--output', 'json']))
  assert.equal(status.API_URL, 'http://127.0.0.1:60321')
  assert.equal(new URL(status.DB_URL).hostname, '127.0.0.1')
  assert.equal(new URL(status.DB_URL).port, '60322')
  const output = run(['gen', 'types', 'typescript', '--local', '--schema', 'public'])
  const generated = output.split(/\r?\n/)
    .filter(line => !line.startsWith('{"_tag"'))
    .join('\n').trimStart()
  assert.match(generated, /^export type Json\b/)
  assert.match(generated, /export type Database\s*=/)
  assert.doesNotMatch(generated, /\{"_tag"|supabase start is not running/)
  writeFileSync(temporary, generated.endsWith('\n') ? generated : generated + '\n')
  renameSync(temporary, destination)
  console.log('Generated public schema types from isolated Covora_Outreach_API.')
} catch (error) {
  rmSync(temporary, { force: true })
  console.error(error instanceof Error && error.message.startsWith('Local schema type generation failed')
    ? error.message
    : 'Type generation refused an unverified local stack or invalid CLI output; existing types were preserved.')
  process.exitCode = 1
}
