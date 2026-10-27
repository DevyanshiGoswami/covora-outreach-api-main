import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test, type TestContext } from 'node:test'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { createTenant, createUser, type Session } from '../helpers/tenants.ts'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach.ts'

const admin = adminClient()
const projectId = readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([^"]+)"/m)?.[1]
assert.ok(projectId)
const container = execFileSync('docker', ['ps', '--filter', `label=com.supabase.cli.project=${projectId}`, '--filter', 'name=supabase_db_', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim()
assert.ok(container)
function sql(command: string) {
  return execFileSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq', '-c', command], { encoding: 'utf8' }).trim()
}
async function fixture(t: TestContext) {
  const tenant = await createTenant(null, { features: ['outreach_app'] })
  const users: Awaited<ReturnType<typeof createUser>>[] = []
  t.after(async () => {
    await tenant.cleanup()
    for (const user of users) assert.ifError((await admin.auth.admin.deleteUser(user.user.id)).error)
  })
  await grantOutreachMembership(tenant.user.id, tenant.client.id, 'client_admin')
  async function person(role?: 'client_admin' | 'client_member' | 'client_viewer' | 'operator' | 'owner') {
    const user = await createUser({ clientId: null })
    users.push(user)
    if (role === 'owner') await grantOutreachOwner(user.user.id)
    else if (role) await grantOutreachMembership(user.user.id, tenant.client.id, role)
    return user
  }
  return { ...tenant, person }
}
async function invite(session: Session, clientId: string, email: string, role = 'client_member') {
  const result = await session.rpc('create_outreach_invitation', { p_client_id: clientId, p_email: email, p_role: role })
  assert.ifError(result.error)
  assert.equal(result.data?.length, 1)
  return result.data![0]
}
async function membership(userId: string, clientId: string) {
  const result = await admin.from('outreach_memberships').select('*').eq('user_id', userId).eq('client_id', clientId).single()
  assert.ifError(result.error)
  return result.data!
}

test('invitation secrets are returned once, hashed at rest, normalized and absent from safe lists/audit', async (t) => {
  const f = await fixture(t)
  const target = await f.person()
  const invitation = await invite(f.supabase, f.client.id, ` ${target.user.email.toUpperCase()} `)
  assert.match(invitation.token, /^[a-f0-9]{64}$/)
  const raw = await admin.from('outreach_invitations').select('*').eq('id', invitation.invitation_id).single()
  assert.ifError(raw.error)
  assert.equal(raw.data?.email, target.user.email)
  assert.equal(raw.data?.token_hash, createHash('sha256').update(invitation.token).digest('hex'))
  assert.equal(Date.parse(raw.data!.expires_at) - Date.parse(raw.data!.created_at), 7 * 86400000)
  const safe = await f.supabase.from('client_outreach_invitations').select('*').eq('client_id', f.client.id)
  assert.ifError(safe.error)
  assert.equal(safe.data?.length, 1)
  assert.deepEqual(Object.keys(safe.data![0]).sort(), ['client_id', 'created_at', 'email', 'expires_at', 'id', 'role', 'status'])
  const audit = await admin.from('outreach_access_audit').select('*').eq('subject_id', invitation.invitation_id)
  assert.ifError(audit.error)
  assert.equal(audit.data?.[0].event_type, 'invitation_created')
  for (const secret of [target.user.email, invitation.token, raw.data!.token_hash]) assert.equal(JSON.stringify(audit.data).includes(secret), false)
  for (const session of [f.supabase, target.session, anonClient()]) assert.ok((await session.from('outreach_invitations').select('*')).error)
})

test('only managers see their team or invite allowed roles, without global profile inheritance', async (t) => {
  const f = await fixture(t)
  const viewer = await f.person('client_viewer')
  const operator = await f.person('operator')
  const owner = await f.person('owner')
  const stranger = await f.person()
  for (const role of ['operator', 'client_admin', 'agency_owner', 'owner']) {
    assert.ok((await f.supabase.rpc('create_outreach_invitation', { p_client_id: f.client.id, p_email: stranger.user.email, p_role: role })).error)
  }
  for (const session of [viewer.session, operator.session, stranger.session]) {
    assert.equal((await session.rpc('create_outreach_invitation', { p_client_id: f.client.id, p_email: stranger.user.email, p_role: 'client_member' })).error?.code, '42501')
    for (const view of ['client_outreach_team', 'client_outreach_invitations'] as const) {
      const read = await session.from(view).select('*').eq('client_id', f.client.id)
      assert.ifError(read.error)
      assert.deepEqual(read.data, [])
    }
  }
  const team = await f.supabase.from('client_outreach_team').select('*').eq('client_id', f.client.id)
  assert.ifError(team.error)
  assert.deepEqual(team.data?.map((row) => row.user_id).sort(), [f.user.id, viewer.user.id, operator.user.id].sort())
  assert.deepEqual(Object.keys(team.data![0]).sort(), ['client_id', 'email', 'is_agency_owner', 'role', 'state', 'user_id', 'version'])
  await invite(owner.session, f.client.id, stranger.user.email, 'operator')
  assert.ifError((await admin.from('client_features').update({ enabled: false }).eq('client_id', f.client.id).eq('feature', 'outreach_app')).error)
  assert.equal((await owner.session.rpc('create_outreach_invitation', { p_client_id: f.client.id, p_email: 'new@test.local', p_role: 'client_admin' })).error?.code, '42501')
})

test('only the verified intended identity can inspect or accept, with uniform denied errors', async (t) => {
  const f = await fixture(t)
  const target = await f.person()
  const other = await f.person()
  const invitation = await invite(f.supabase, f.client.id, target.user.email)
  for (const rpc of ['inspect_outreach_invitation', 'accept_outreach_invitation'] as const) {
    const wrong = await other.session.rpc(rpc, { p_token: invitation.token })
    const invalid = await target.session.rpc(rpc, { p_token: '0'.repeat(64) })
    const malformed = await target.session.rpc(rpc, { p_token: 'invalid' })
    assert.equal(wrong.error?.code, '42501')
    assert.equal(invalid.error?.code, '42501')
    assert.equal(malformed.error?.code, '42501')
    assert.equal(wrong.error?.message, invalid.error?.message)
    assert.equal(wrong.error?.message, malformed.error?.message)
  }
  sql(`update auth.users set email_confirmed_at = null where id = '${target.user.id}'`)
  assert.equal((await target.session.rpc('accept_outreach_invitation', { p_token: invitation.token })).error?.code, '42501')
  sql(`update auth.users set email_confirmed_at = now() where id = '${target.user.id}'`)
  const inspect = await target.session.rpc('inspect_outreach_invitation', { p_token: invitation.token })
  assert.ifError(inspect.error)
  assert.equal(inspect.data?.[0].client_id, f.client.id)
  assert.equal(inspect.data?.[0].status, 'pending')
  assert.equal(JSON.stringify(inspect.data).includes(target.user.email), false)
})

test('concurrent acceptance grants once, preserves dedicated profile/password and permits harmless replay', async (t) => {
  const f = await fixture(t)
  const target = await f.person()
  const before = await admin.from('profiles').select('*').eq('id', target.user.id).single()
  const invitation = await invite(f.supabase, f.client.id, target.user.email)
  const accepted = await Promise.all(Array.from({ length: 8 }, () => target.session.rpc('accept_outreach_invitation', { p_token: invitation.token })))
  for (const result of accepted) { assert.ifError(result.error); assert.equal(result.data, f.client.id) }
  assert.equal((await membership(target.user.id, f.client.id)).version, 1)
  const audit = await admin.from('outreach_access_audit').select('event_type').eq('subject_id', invitation.invitation_id).eq('event_type', 'invitation_accepted')
  assert.ifError(audit.error)
  assert.equal(audit.data?.length, 1)
  const after = await admin.from('profiles').select('*').eq('id', target.user.id).single()
  assert.deepEqual(after.data, before.data)
  assert.ifError((await anonClient().auth.signInWithPassword({ email: target.user.email, password: target.user.password })).error)
  const foreign = await target.session.from('clients').select('id').eq('id', f.client.id)
  assert.ok(foreign.error, 'membership does not expose service-owned tenant base rows')
  assert.ifError((await target.session.rpc('inspect_outreach_invitation', { p_token: invitation.token })).error)
})

test('reissue invalidates the previous secret and expiration is visible without a cron', async (t) => {
  const f = await fixture(t)
  const target = await f.person()
  const first = await invite(f.supabase, f.client.id, target.user.email)
  const second = await invite(f.supabase, f.client.id, target.user.email, 'client_viewer')
  assert.notEqual(first.token, second.token)
  assert.equal((await target.session.rpc('accept_outreach_invitation', { p_token: first.token })).error?.code, '42501')
  assert.ifError((await admin.from('outreach_invitations').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', second.invitation_id)).error)
  const list = await f.supabase.from('client_outreach_invitations').select('status').eq('id', second.invitation_id).single()
  assert.equal(list.data?.status, 'expired')
  for (const rpc of ['inspect_outreach_invitation', 'accept_outreach_invitation'] as const) assert.equal((await target.session.rpc(rpc, { p_token: second.token })).error?.code, '42501')
})

test('invitation revocation is role-scoped and idempotent, accepted invitations cannot be reset', async (t) => {
  const f = await fixture(t)
  const target = await f.person()
  const owner = await f.person('owner')
  const invitation = await invite(owner.session, f.client.id, target.user.email, 'client_admin')
  assert.equal((await f.supabase.rpc('revoke_outreach_invitation', { p_invitation_id: invitation.invitation_id })).error?.code, '42501')
  for (let i = 0; i < 2; i++) assert.ifError((await owner.session.rpc('revoke_outreach_invitation', { p_invitation_id: invitation.invitation_id })).error)
  assert.equal((await target.session.rpc('accept_outreach_invitation', { p_token: invitation.token })).error?.code, '42501')
  const next = await invite(f.supabase, f.client.id, target.user.email)
  assert.ifError((await target.session.rpc('accept_outreach_invitation', { p_token: next.token })).error)
  assert.equal((await f.supabase.rpc('revoke_outreach_invitation', { p_invitation_id: next.invitation_id })).error?.code, '22023')
})

test('client administrators cannot replace an owner-issued elevated invitation', async (t) => {
  const f = await fixture(t)
  const target = await f.person()
  const owner = await f.person('owner')
  const invitation = await invite(owner.session, f.client.id, target.user.email, 'operator')
  const replacement = await f.supabase.rpc('create_outreach_invitation', {
    p_client_id: f.client.id, p_email: target.user.email, p_role: 'client_member',
  })
  assert.equal(replacement.error?.code, '42501')
  assert.ifError((await target.session.rpc('accept_outreach_invitation', { p_token: invitation.token })).error)
  assert.equal((await membership(target.user.id, f.client.id)).role, 'operator')
})

test('inviter demotion invalidates outstanding invitations immediately', async (t) => {
  const f = await fixture(t)
  const target = await f.person()
  const owner = await f.person('owner')
  const invitation = await invite(f.supabase, f.client.id, target.user.email)
  assert.ifError((await owner.session.rpc('change_outreach_membership', { p_client_id: f.client.id, p_user_id: f.user.id, p_role: 'client_member', p_state: 'active', p_expected_version: 1 })).error)
  const raw = await admin.from('outreach_invitations').select('status').eq('id', invitation.invitation_id).single()
  assert.equal(raw.data?.status, 'revoked')
  assert.equal((await target.session.rpc('accept_outreach_invitation', { p_token: invitation.token })).error?.code, '42501')
})

test('acceptance rechecks inviter authority and feature gates after service-side changes', async (t) => {
  const f = await fixture(t)
  const target = await f.person()
  const invitation = await invite(f.supabase, f.client.id, target.user.email)
  assert.ifError((await admin.from('outreach_memberships').update({ state: 'revoked' }).eq('client_id', f.client.id).eq('user_id', f.user.id)).error)
  assert.equal((await target.session.rpc('accept_outreach_invitation', { p_token: invitation.token })).error?.code, '42501')
  await grantOutreachMembership(f.user.id, f.client.id, 'client_admin')
  assert.ifError((await admin.from('client_features').update({ enabled: false }).eq('client_id', f.client.id).eq('feature', 'outreach_app')).error)
  assert.equal((await target.session.rpc('accept_outreach_invitation', { p_token: invitation.token })).error?.code, '42501')
})

test('a pending invitation cannot upgrade existing active/suspended access or survive a target version change', async (t) => {
  const f = await fixture(t)
  const target = await f.person()
  const invitation = await invite(f.supabase, f.client.id, target.user.email)
  await grantOutreachMembership(target.user.id, f.client.id, 'client_viewer')
  assert.equal((await target.session.rpc('accept_outreach_invitation', { p_token: invitation.token })).error?.code, '42501')
  for (const state of ['active', 'suspended'] as const) {
    assert.ifError((await admin.from('outreach_memberships').update({ state }).eq('client_id', f.client.id).eq('user_id', target.user.id)).error)
    assert.equal((await f.supabase.rpc('create_outreach_invitation', { p_client_id: f.client.id, p_email: target.user.email, p_role: 'client_member' })).error?.code, '22023')
  }
  assert.ifError((await admin.from('outreach_memberships').update({ state: 'revoked' }).eq('client_id', f.client.id).eq('user_id', target.user.id)).error)
  const fresh = await invite(f.supabase, f.client.id, target.user.email)
  assert.ifError((await admin.from('outreach_memberships').update({ role: 'client_member' }).eq('client_id', f.client.id).eq('user_id', target.user.id)).error)
  assert.equal((await target.session.rpc('accept_outreach_invitation', { p_token: fresh.token })).error?.code, '42501')
  const current = await invite(f.supabase, f.client.id, target.user.email)
  assert.ifError((await target.session.rpc('accept_outreach_invitation', { p_token: current.token })).error)
  assert.equal((await membership(target.user.id, f.client.id)).state, 'active')
})

test('role changes use expected versions, revoke stale invitations and never elevate through replay', async (t) => {
  const f = await fixture(t)
  const target = await f.person()
  const invitation = await invite(f.supabase, f.client.id, target.user.email)
  assert.ifError((await target.session.rpc('accept_outreach_invitation', { p_token: invitation.token })).error)
  const args = { p_client_id: f.client.id, p_user_id: target.user.id, p_role: 'client_viewer', p_state: 'active', p_expected_version: 1 }
  const changes = await Promise.all([f.supabase.rpc('change_outreach_membership', args), f.supabase.rpc('change_outreach_membership', args)])
  assert.equal(changes.filter((result) => !result.error).length, 1)
  assert.equal(changes.find((result) => result.error)?.error?.code, '22023')
  assert.ifError((await target.session.rpc('accept_outreach_invitation', { p_token: invitation.token })).error)
  assert.equal((await membership(target.user.id, f.client.id)).role, 'client_viewer')
  assert.equal((await membership(target.user.id, f.client.id)).version, 2)
  assert.ifError((await f.supabase.rpc('change_outreach_membership', { ...args, p_state: 'revoked', p_expected_version: 2 })).error)
  for (const rpc of ['inspect_outreach_invitation', 'accept_outreach_invitation'] as const) assert.equal((await target.session.rpc(rpc, { p_token: invitation.token })).error?.code, '42501')
  const workspaces = await target.session.from('client_outreach_workspaces').select('*')
  assert.deepEqual(workspaces.data, [])
  const fresh = await invite(f.supabase, f.client.id, target.user.email)
  assert.ifError((await f.supabase.rpc('change_outreach_membership', { ...args, p_state: 'active', p_expected_version: 3 })).error)
  assert.equal((await target.session.rpc('accept_outreach_invitation', { p_token: fresh.token })).error?.code, '42501')
})

test('client administrators cannot change higher roles, themselves, or another workspace', async (t) => {
  const f = await fixture(t)
  const target = await f.person('client_member')
  const operator = await f.person('operator')
  const args = { p_client_id: f.client.id, p_user_id: target.user.id, p_role: 'client_viewer', p_state: 'active', p_expected_version: 1 }
  for (const input of [{ ...args, p_role: 'operator' }, { ...args, p_user_id: operator.user.id }, { ...args, p_user_id: f.user.id }, { ...args, p_client_id: randomUUID() }]) {
    assert.equal((await f.supabase.rpc('change_outreach_membership', input)).error?.code, '42501')
  }
  assert.equal((await operator.session.rpc('change_outreach_membership', args)).error?.code, '42501')
  assert.equal((await f.supabase.rpc('change_outreach_membership', { ...args, p_expected_version: 0 })).error?.code, '22023')
  assert.ifError((await f.supabase.rpc('change_outreach_membership', args)).error)
  const audit = await admin.from('outreach_access_audit').select('details').eq('subject_id', target.user.id).eq('event_type', 'membership_updated')
  assert.equal(audit.data?.length, 1)
  assert.equal(JSON.stringify(audit.data).includes(target.user.email), false)
})

test('accepted invitation replay cannot undo suspension and anonymous RPCs grant nothing', async (t) => {
  const f = await fixture(t)
  const target = await f.person()
  const invitation = await invite(f.supabase, f.client.id, target.user.email)
  assert.ok((await anonClient().rpc('accept_outreach_invitation', { p_token: invitation.token })).error)
  assert.ifError((await target.session.rpc('accept_outreach_invitation', { p_token: invitation.token })).error)
  assert.ifError((await f.supabase.rpc('change_outreach_membership', {
    p_client_id: f.client.id, p_user_id: target.user.id, p_role: 'client_member', p_state: 'suspended', p_expected_version: 1,
  })).error)
  for (const rpc of ['inspect_outreach_invitation', 'accept_outreach_invitation'] as const) {
    assert.equal((await target.session.rpc(rpc, { p_token: invitation.token })).error?.code, '42501')
  }
  assert.equal((await membership(target.user.id, f.client.id)).state, 'suspended')
})

test('concurrent revoke and accept choose one durable outcome without partial membership grants', async (t) => {
  const f = await fixture(t)
  const target = await f.person()
  const invitation = await invite(f.supabase, f.client.id, target.user.email)
  const [revoke, accept] = await Promise.all([
    f.supabase.rpc('revoke_outreach_invitation', { p_invitation_id: invitation.invitation_id }),
    target.session.rpc('accept_outreach_invitation', { p_token: invitation.token }),
  ])
  assert.equal([revoke, accept].filter((result) => !result.error).length, 1)
  const state = await admin.from('outreach_invitations').select('status').eq('id', invitation.invitation_id).single()
  if (!revoke.error) {
    assert.equal(accept.error?.code, '42501')
    assert.equal(state.data?.status, 'revoked')
    const members = await admin.from('outreach_memberships').select('user_id').eq('client_id', f.client.id).eq('user_id', target.user.id)
    assert.deepEqual(members.data, [])
  } else {
    assert.equal(revoke.error.code, '22023')
    assert.equal(state.data?.status, 'accepted')
    assert.equal((await membership(target.user.id, f.client.id)).state, 'active')
  }
})

test('unknown-at-invite identities can accept after verified enrollment without creating a profile', async (t) => {
  const f = await fixture(t)
  const email = `outreach-${randomUUID()}@test.local`
  const invitation = await invite(f.supabase, f.client.id, email, 'client_viewer')
  const password = `Fixture-${randomUUID()}`
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  assert.ifError(created.error)
  const id = created.data.user!.id
  t.after(async () => { assert.ifError((await admin.auth.admin.deleteUser(id)).error) })
  const session = anonClient()
  assert.ifError((await session.auth.signInWithPassword({ email, password })).error)
  assert.ifError((await session.rpc('accept_outreach_invitation', { p_token: invitation.token })).error)
  const profile = await admin.from('profiles').select('id').eq('id', id)
  assert.deepEqual(profile.data, [])
})
