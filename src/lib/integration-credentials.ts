import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import { createSupabaseAdminClient } from './supabase/admin'

/** Called only from an already authorized provider operation. Never expose the result in a DTO. */
export async function resolveIntegrationCredential(ref: string, credentials: Readonly<Record<string, string | undefined>> = process.env, admin?: SupabaseClient<Database>): Promise<string | undefined> {
  if (!/^OUTREACH_(INSTANTLY|HEYREACH)_[A-Z0-9_]{1,100}$/.test(ref)) return undefined
  if (!/^OUTREACH_(INSTANTLY|HEYREACH)_VAULT_[A-F0-9]{32}$/.test(ref)) return credentials[ref]?.trim() || undefined
  try {
    const result = await (admin ?? createSupabaseAdminClient()).rpc('read_outreach_integration_key', { p_ref: ref })
    return !result.error && typeof result.data === 'string' ? result.data : undefined
  } catch { return undefined }
}
