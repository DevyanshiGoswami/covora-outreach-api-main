import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

/** Extra product authority before the legacy portal may use a privileged client. */
export async function requireOutreachOwner(client: SupabaseClient<Database>, clientId?: string): Promise<string[]> {
  const fail = () => new Error('Outbound agency access is unavailable.')
  const { data: { user }, error: authError } = await client.auth.getUser()
  if (authError || !user) throw fail()
  const ids: string[] = []
  for (let offset = 0; ; offset += 500) {
    let query = client.from('client_outreach_workspaces')
      .select('client_id, role').eq('role', 'agency_owner')
      .order('client_id').range(offset, offset + 499)
    if (clientId) query = query.eq('client_id', clientId)
    const { data, error } = await query
    if (error || !data) throw fail()
    for (const row of data) {
      if (!row.client_id || row.role !== 'agency_owner' || (clientId && row.client_id !== clientId)) throw fail()
      ids.push(row.client_id)
    }
    if (data.length < 500) break
  }
  if (!ids.length) throw fail()
  return ids
}
