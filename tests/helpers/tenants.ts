import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '../../src/lib/database.types.ts'
import { adminClient, anonClient } from './admin.ts'

export type Session = SupabaseClient<Database>
export type CleanupScope = { after(fn: () => unknown): unknown } | null
export type TenantUser = { id: string; email: string; password: string }
export type Tenant = {
  client: { id: string; slug: string; name: string }; user: TenantUser;
  supabase: Session; cleanup: () => Promise<void>
}
export type CreateTenantOptions = {
  slug?: string; name?: string;
  features?: (string | { feature: string; config?: Json })[];
  client?: Partial<Database['public']['Tables']['clients']['Insert']>
}
export function fixtureSlug(prefix = 't') { return `${prefix}-${randomUUID().slice(0, 12)}` }
export async function createClientRow(t: CleanupScope, options: CreateTenantOptions = {}) {
  const slug = options.slug ?? fixtureSlug()
  const row = await adminClient().from('clients').insert({ name: options.name ?? `Fixture ${slug}`, slug, ...options.client }).select('id,slug,name').single()
  assert.ifError(row.error)
  for (const entry of options.features ?? []) {
    await enableFeature(row.data!.id, typeof entry === 'string' ? entry : entry.feature, typeof entry === 'string' ? {} : entry.config ?? {})
  }
  t?.after(async () => { assert.ifError((await adminClient().from('clients').delete().eq('id', row.data!.id)).error) })
  return row.data!
}
export async function enableFeature(clientId: string, feature: string, config: NonNullable<Json> = {}) {
  assert.equal(feature, 'outreach_app')
  assert.ifError((await adminClient().from('client_features').upsert({ client_id: clientId, feature, enabled: true, config })).error)
  return true
}
export async function createUser(options: { clientId?: string | null; label?: string; email?: string } = {}) {
  const email = options.email ?? `fixture-${randomUUID()}@example.test`
  const password = `Fixture-${randomUUID()}`
  const created = await adminClient().auth.admin.createUser({ email, password, email_confirm: true })
  assert.ifError(created.error)
  const id = created.data.user!.id
  assert.ifError((await adminClient().from('profiles').insert({ id, full_name: options.label ?? 'Synthetic workspace member' })).error)
  const session = anonClient()
  assert.ifError((await session.auth.signInWithPassword({ email, password })).error)
  return { user: { id, email, password }, session }
}
export async function createTenant(t: CleanupScope, options: CreateTenantOptions = {}): Promise<Tenant> {
  const client = await createClientRow(null, options)
  const { user, session } = await createUser({ label: client.slug })
  let done = false
  const cleanup = async () => {
    if (done) return
    assert.ifError((await adminClient().from('clients').delete().eq('id', client.id)).error)
    assert.ifError((await adminClient().auth.admin.deleteUser(user.id)).error)
    done = true
  }
  t?.after(cleanup)
  return { client, user, supabase: session, cleanup }
}
/** Compatibility name for retained tests; this identity receives no role. */
export async function createAdmin(t: CleanupScope) {
  const { user, session } = await createUser({ label: 'Unassigned identity' })
  let done = false
  const cleanup = async () => {
    if (done) return
    assert.ifError((await adminClient().auth.admin.deleteUser(user.id)).error)
    done = true
  }
  t?.after(cleanup)
  return { user, supabase: session, cleanup }
}
