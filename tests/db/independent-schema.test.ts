import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { createAdmin, createTenant } from '../helpers/tenants.ts'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach.ts'

const admin = adminClient()
function sql(command: string) {
  const label = execFileSync('docker', ['inspect', '--format', '{{index .Config.Labels "com.supabase.cli.project"}}', 'supabase_db_Covora_Outreach_API'], { encoding: 'utf8' }).trim()
  assert.equal(label, 'Covora_Outreach_API')
  return execFileSync('docker', ['exec', 'supabase_db_Covora_Outreach_API', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq', '-c', command], { encoding: 'utf8' }).trim()
}

test('independent foundation has no legacy data tables, inferred roles or open RLS tables', () => {
  assert.equal(sql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;"), '0')
  assert.equal(sql("select count(*) from information_schema.tables where table_schema='public' and table_name in ('posts','brand_outreach_campaigns','instantly_inbox_connections','lead_dms','lead_outreach_messages','cron_runs','ops_checks');"), '0')
  assert.equal(sql("select string_agg(column_name,',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='profiles';"), 'id,full_name')
  assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='outreach_campaigns' and column_name='brand_outreach_campaign_id';"), '0')
  assert.equal(sql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and (has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE'));"), '0')
  assert.equal(sql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and has_function_privilege('anon',p.oid,'EXECUTE');"), '0')
  assert.equal(sql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where n.nspname in('public','outreach_private') and a.grantee=0 and a.privilege_type='EXECUTE';"), '0')
})

test('Auth identity and display name do not imply access; active tenant roles and feature gates do', async (t) => {
  const a = await createTenant(t, { features: ['outreach_app'] })
  const b = await createTenant(t, { features: ['outreach_app'] })
  const off = await createTenant(t)
  const owner = await createAdmin(t)
  const operator = await createAdmin(t)
  assert.deepEqual((await a.supabase.from('client_outreach_workspaces').select('*')).data, [])
  await grantOutreachMembership(a.user.id, a.client.id, 'client_viewer')
  await grantOutreachMembership(operator.user.id, a.client.id, 'operator')
  await grantOutreachOwner(owner.user.id)
  assert.deepEqual((await a.supabase.from('client_outreach_workspaces').select('client_id')).data, [{ client_id: a.client.id }])
  assert.deepEqual((await operator.supabase.from('client_outreach_workspaces').select('client_id')).data, [{ client_id: a.client.id }])
  const owned = await owner.supabase.from('client_outreach_workspaces').select('client_id').in('client_id', [a.client.id, b.client.id, off.client.id])
  assert.ifError(owned.error)
  assert.deepEqual(owned.data!.map(row => row.client_id).sort(), [a.client.id, b.client.id].sort())
  assert.ifError((await admin.from('outreach_memberships').update({ state: 'revoked' }).eq('user_id', a.user.id)).error)
  assert.deepEqual((await a.supabase.from('client_outreach_workspaces').select('*')).data, [])
  assert.ifError((await admin.from('client_features').update({ enabled: false }).eq('client_id', a.client.id)).error)
  assert.deepEqual((await owner.supabase.from('client_outreach_workspaces').select('*').eq('client_id', a.client.id)).data, [])
})

test('neutral projections hide provider IDs and base tables from every signed-in tenant', async (t) => {
  const a = await createTenant(t, { features: ['outreach_app'] })
  const b = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(a.user.id, a.client.id)
  await grantOutreachMembership(b.user.id, b.client.id)
  const providerId = randomUUID()
  const inserted = await admin.from('outreach_campaigns').insert({ client_id: a.client.id, provider_campaign_id: providerId, name: 'Synthetic campaign', totals: { sent: 4, provider_secret: 99 }, schedule: { days: [1], timezone: 'UTC', provider_id: 'hidden' } }).select('id').single()
  assert.ifError(inserted.error)
  const own = await a.supabase.from('client_outreach_campaigns').select('*')
  assert.ifError(own.error)
  assert.equal(own.data?.length, 1)
  assert.equal(JSON.stringify(own.data).includes(providerId), false)
  assert.equal(JSON.stringify(own.data).includes('provider_'), false)
  assert.deepEqual((await b.supabase.from('client_outreach_campaigns').select('*')).data, [])
  for (const session of [a.supabase, b.supabase, anonClient()]) {
    assert.ok((await session.from('outreach_campaigns').select('*')).error)
    assert.ok((await session.from('client_features').select('*')).error)
    assert.ok((await session.from('profiles').select('*')).error)
  }
})

test('independent LinkedIn cohorts retain unknown outcomes and tenant denial', async (t) => {
  const a = await createTenant(t, { features: ['outreach_app'] })
  const b = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(a.user.id, a.client.id)
  await grantOutreachMembership(b.user.id, b.client.id)
  assert.ifError((await admin.from('outreach_linkedin_activity').insert({ client_id: a.client.id, day: '2026-10-05', source: 'outreach_log', sent: 3 })).error)
  assert.ok((await admin.from('outreach_linkedin_activity').insert({ client_id: a.client.id, day: '2026-10-06', source: 'outreach_log', sent: 3, replied: 1 })).error)
  const own = await a.supabase.from('client_outreach_linkedin_daily').select('*')
  assert.ifError(own.error)
  assert.equal(own.data?.[0].replied, null)
  assert.equal(own.data?.[0].meeting_booked, null)
  assert.deepEqual((await b.supabase.from('client_outreach_linkedin_daily').select('*')).data, [])
  assert.ok((await a.supabase.from('outreach_linkedin_activity').select('*')).error)
})

test('email identities cannot be registered or bound across product-local tenants in either order', async (t) => {
  const a = await createTenant(t, { features: ['outreach_app'] })
  const b = await createTenant(t, { features: ['outreach_app'] })
  const owner = await createAdmin(t)
  await grantOutreachOwner(owner.user.id)
  for (const client of [a.client, b.client]) {
    assert.ifError((await owner.supabase.rpc('configure_outreach_account_workspace', { p_client_id: client.id, p_remote_workspace_id: randomUUID(), p_credential_ref: 'OUTREACH_INSTANTLY_TEST_' + randomUUID().replaceAll('-', '').toUpperCase(), p_enabled: true })).error)
  }
  const workspace = await admin.from('outreach_reply_workspaces').insert({ client_id: b.client.id, channel: 'email', remote_workspace_id: randomUUID(), credential_ref: 'OUTREACH_INSTANTLY_REPLY_' + randomUUID().replaceAll('-', '').toUpperCase() }).select('id').single()
  assert.ifError(workspace.error)
  const first = `sender-${randomUUID()}@example.test`
  assert.ifError((await admin.from('outreach_reply_senders').insert({ client_id: b.client.id, channel: 'email', workspace_id: workspace.data!.id, remote_sender_id: first, sender_address: first, sender_label: 'Synthetic' })).error)
  assert.equal((await owner.supabase.rpc('register_outreach_account', { p_client_id: a.client.id, p_email: first.toUpperCase(), p_display_name: '' })).error?.code, '22023')
  assert.ifError((await owner.supabase.rpc('register_outreach_account', { p_client_id: b.client.id, p_email: first, p_display_name: '' })).error)
  const second = `account-${randomUUID()}@example.test`
  assert.ifError((await owner.supabase.rpc('register_outreach_account', { p_client_id: a.client.id, p_email: second, p_display_name: '' })).error)
  assert.equal((await admin.from('outreach_reply_senders').insert({ client_id: b.client.id, channel: 'email', workspace_id: workspace.data!.id, remote_sender_id: second, sender_address: second, sender_label: 'Synthetic' })).error?.code, '23505')
  const racedAddress = `race-${randomUUID()}@example.test`
  const raced = await Promise.all([
    owner.supabase.rpc('register_outreach_account', { p_client_id: a.client.id, p_email: racedAddress, p_display_name: '' }),
    admin.from('outreach_reply_senders').insert({ client_id: b.client.id, channel: 'email', workspace_id: workspace.data!.id, remote_sender_id: racedAddress, sender_address: racedAddress, sender_label: 'Synthetic' }),
  ])
  assert.equal(raced.filter(result => !result.error).length, 1, 'cross-table concurrent reservation has exactly one owner')
})

test('public signup stays disabled while deliberately provisioned password identities can sign in', async (t) => {
  const identity = await createAdmin(t)
  const login = await anonClient().auth.signInWithPassword({ email: identity.user.email.toUpperCase(), password: identity.user.password })
  assert.ifError(login.error)
  assert.equal(login.data.user?.id, identity.user.id)
  const signup = await anonClient().auth.signUp({ email: `unauthorized-${randomUUID()}@example.test`, password: `Fixture-${randomUUID()}` })
  assert.ok(signup.error)
  assert.equal(signup.data.user, null)
})

test('new bindings start with sending and synchronization independently disabled', async (t) => {
  const a = await createTenant(t, { features: ['outreach_app'] })
  const workspace = await admin.from('outreach_reply_workspaces').insert({ client_id: a.client.id, channel: 'linkedin', remote_workspace_id: randomUUID(), credential_ref: 'OUTREACH_HEYREACH_TEST_' + randomUUID().replaceAll('-', '').toUpperCase() }).select('*').single()
  assert.ifError(workspace.error)
  const sender = await admin.from('outreach_reply_senders').insert({ client_id: a.client.id, channel: 'linkedin', workspace_id: workspace.data!.id, remote_sender_id: 'synthetic-' + randomUUID(), sender_address: 'https://www.linkedin.com/in/synthetic-fixture', sender_label: 'Synthetic' }).select('*').single()
  assert.ifError(sender.error)
  assert.equal(workspace.data!.enabled, false)
  assert.equal(workspace.data!.sync_enabled, false)
  assert.equal(sender.data!.enabled, false)
  assert.equal(sender.data!.sync_cursor, null)
  assert.equal(sender.data!.sync_started_at, null)
  assert.equal(sender.data!.synced_at, null)
})

test('worker observability is service-only and creates no scheduled execution', async (t) => {
  const identity = await createAdmin(t)
  const name = 'test-' + randomUUID().slice(0, 8)
  for (const session of [identity.supabase, anonClient()]) {
    assert.ok((await session.rpc('record_worker_heartbeat', { worker_name: name, succeeded: true, result_note: 'Synthetic' })).error)
    assert.ok((await session.from('worker_heartbeats').select('*')).error)
  }
  assert.ifError((await admin.rpc('record_worker_heartbeat', { worker_name: name, succeeded: true, result_note: 'Synthetic' })).error)
  t.after(async () => { assert.ifError((await admin.from('worker_heartbeats').delete().eq('name', name)).error) })
  const row = await admin.from('worker_heartbeats').select('*').eq('name', name).single()
  assert.ifError(row.error)
  assert.ok(row.data!.last_ok_at)
  assert.ifError((await admin.rpc('record_worker_heartbeat', { worker_name: name, succeeded: false, result_note: 'Synthetic failure' })).error)
  const failed = await admin.from('worker_heartbeats').select('*').eq('name', name).single()
  assert.equal(failed.data!.last_ok_at, row.data!.last_ok_at)
  assert.equal(sql("select count(*) from pg_extension where extname='pg_cron';"), '0')
})
