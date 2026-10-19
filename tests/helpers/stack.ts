import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// Read only the local checkout's config; no remote URL or arbitrary container override.
export const testProjectId = readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([^"]+)"/m)?.[1] ?? ''
assert.match(testProjectId, /^Covora_[A-Za-z0-9_]+$/)
export const testDatabaseContainer = `supabase_db_${testProjectId}`
