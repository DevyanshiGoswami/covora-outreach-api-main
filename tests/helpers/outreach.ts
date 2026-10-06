import assert from 'node:assert/strict'
import { adminClient } from './admin.ts'

/** Fixture grants are explicit; creating a legacy tenant must never grant this product. */
export async function grantOutreachMembership(
  userId: string,
  clientId: string,
  role: 'client_admin' | 'client_member' | 'client_viewer' | 'operator' = 'client_admin',
) {
  assert.ifError((await adminClient().from('outreach_memberships').upsert({
    user_id: userId, client_id: clientId, role, state: 'active',
  }, { onConflict: 'user_id,client_id' })).error)
}

export async function grantOutreachOwner(userId: string) {
  assert.ifError((await adminClient().from('outreach_agency_memberships').upsert({
    user_id: userId, role: 'owner', state: 'active',
  })).error)
}
