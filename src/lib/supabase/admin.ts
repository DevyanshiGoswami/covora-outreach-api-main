import 'server-only'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { requireRuntimeDatabase } from '@/lib/runtime-config'

/** Privileged access is confined to the dedicated Outreach database. */
export function createSupabaseAdminClient(fetchImpl: typeof fetch = fetch) {
  const config = requireRuntimeDatabase(true)
  return createClient<Database>(config.url, config.serviceKey!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const signals = [AbortSignal.timeout(8000)]
      if (init?.signal) signals.push(init.signal)
      if (input instanceof Request) signals.push(input.signal)
      return fetchImpl(input, { ...init, signal: AbortSignal.any(signals), redirect: 'error', cache: 'no-store' })
    } },
  })
}
