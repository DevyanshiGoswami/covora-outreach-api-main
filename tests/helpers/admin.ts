import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../src/lib/database.types.ts'
import { loadTestEnv } from './env.ts'

loadTestEnv()
let cached: SupabaseClient<Database> | null = null
export function adminClient(): SupabaseClient<Database> {
  const { URL, SERVICE } = loadTestEnv()
  return cached ??= createClient<Database>(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
}
export function anonClient(): SupabaseClient<Database> {
  const { URL, ANON } = loadTestEnv()
  return createClient<Database>(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
}
