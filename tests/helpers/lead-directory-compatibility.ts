import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../src/lib/database.types.ts'

/** Existing directory scenarios run against both versions to detect CTE drift. */
export async function compatibleDirectory(client: SupabaseClient<Database>, args: Database['public']['Functions']['list_outreach_leads']['Args']) {
  const prior = await client.rpc('list_outreach_leads', args)
  const next = await client.rpc('list_outreach_leads_v2', args)
  assert.equal(next.error?.code, prior.error?.code, 'v2 must preserve the v1 authorization and validation result')
  if (!prior.error) {
    const projected = structuredClone(next.data) as { [key: string]: unknown; leads: Record<string, unknown>[] }
    assert.equal(projected.athleteSegmentsEnabled, args.p_client_id === '26a2cffb-47f4-4231-9195-b4f772751c6d', 'Athlete groups must remain EPM-only')
    delete projected.athleteSegmentsEnabled
    delete projected.tierEnabled
    delete projected.audienceEnabled
    delete projected.locationOptions
    for (const lead of projected.leads) {
      if (lead.athleteSegments !== undefined) {
        assert.equal(args.p_client_id, '26a2cffb-47f4-4231-9195-b4f772751c6d')
        assert.equal(lead.audience, 'athletes')
      }
      delete lead.athleteSegments
      delete lead.hiringTierEvidence
      delete lead.hiringTier
      delete lead.audience
      delete lead.personLocation
      delete lead.icebreaker
    }
    assert.deepEqual(projected, prior.data, 'v2 must preserve the legacy directory result for legacy fixtures')
  }
  return prior
}
