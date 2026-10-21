import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { createTenant, createUser, type Session } from '../helpers/tenants.ts'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach.ts'

const EPM = '26a2cffb-47f4-4231-9195-b4f772751c6d'
const admin = adminClient()
async function fixture(t: TestContext, enabled = true) {
  const tenant = await createTenant(null, { features: [{ feature: 'outreach_app', config: { presentation_mode: 'preview' } }], client: { id: EPM } })
  const users: Awaited<ReturnType<typeof createUser>>[] = []
  t.after(async () => {
    await tenant.cleanup()
    for (const item of users) assert.ifError((await admin.auth.admin.deleteUser(item.user.id)).error)
  })
  await grantOutreachMembership(tenant.user.id, EPM, 'client_admin')
  assert.ifError((await admin.from('outreach_comment_settings').insert({ client_id: EPM, enabled })).error)
  async function person(role?: 'client_admin' | 'client_member' | 'client_viewer' | 'operator' | 'owner') {
    const p = await createUser({ label: 'Actual authenticated author' })
    users.push(p)
    if (role === 'owner') await grantOutreachOwner(p.user.id)
    else if (role) await grantOutreachMembership(p.user.id, EPM, role)
    return p
  }
  return { ...tenant, person }
}
async function create(session: Session, command = randomUUID(), title = 'Please change the template', body = 'This is a real saved request.') {
  const result = await session.rpc('create_outreach_comment', { p_client: EPM, p_command: command, p_title: title, p_body: body })
  assert.ifError(result.error)
  assert.ok(result.data)
  return result.data
}
async function detail(session: Session, id: string, offset = 0) {
  const result = await session.rpc('get_outreach_comment', { p_client: EPM, p_request: id, p_offset: offset })
  assert.ifError(result.error)
  return result.data as unknown as { request: { id: string; body: string; authorName: string; replyCount: number; version: number; status: string; updatedAt: string }; messages: { id: string; body: string; authorName: string; requestId: string; clientId: string }[]; hasMore: boolean }
}

test('comments are real in preview, default off, and EPM-only service configuration cannot be changed by clients', async (t) => {
  const f = await fixture(t, false)
  const off = await f.supabase.rpc('list_outreach_comments', { p_client: EPM })
  assert.ifError(off.error)
  assert.deepEqual(off.data, { clientId: EPM, enabled: false, permissions: { canComment: false, canManage: false }, requests: [], hasMore: false })
  assert.equal((await f.supabase.rpc('create_outreach_comment', { p_client: EPM, p_command: randomUUID(), p_title: 'Request', p_body: 'Text' })).error?.code, '42501')
  assert.ok((await f.supabase.from('outreach_comment_settings').update({ enabled: true }).eq('client_id', EPM)).error)
  assert.ifError((await admin.from('outreach_comment_settings').update({ enabled: true }).eq('client_id', EPM)).error)
  const id = await create(f.supabase)
  assert.equal((await detail(f.supabase, id)).request.id, id)
  const foreign = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(foreign.user.id, foreign.client.id, 'client_admin')
  assert.ok((await admin.from('outreach_comment_settings').insert({ client_id: foreign.client.id, enabled: true })).error)
  const foreignList = await foreign.supabase.rpc('list_outreach_comments', { p_client: foreign.client.id })
  assert.ifError(foreignList.error)
  assert.equal((foreignList.data as { enabled: boolean }).enabled, false)
})

test('member/admin/operator/owner can discuss; viewers only read; only assigned operator and owner change status', async (t) => {
  const f = await fixture(t)
  const viewer = await f.person('client_viewer')
  const member = await f.person('client_member')
  const operator = await f.person('operator')
  const owner = await f.person('owner')
  const id = await create(member.session)
  for (const session of [f.supabase, member.session, operator.session, owner.session]) {
    const reply = await session.rpc('reply_outreach_comment', { p_client: EPM, p_request: id, p_command: randomUUID(), p_body: 'Confirmed detail' })
    assert.ifError(reply.error)
  }
  assert.equal((await detail(viewer.session, id)).request.replyCount, 4)
  for (const session of [f.supabase, member.session, viewer.session]) {
    assert.equal((await session.rpc('set_outreach_comment_status', { p_client: EPM, p_request: id, p_version: 5, p_status: 'in_progress' })).error?.code, '42501')
  }
  assert.equal((await viewer.session.rpc('create_outreach_comment', { p_client: EPM, p_command: randomUUID(), p_title: 'Denied', p_body: 'Text' })).error?.code, '42501')
  assert.equal((await viewer.session.rpc('reply_outreach_comment', { p_client: EPM, p_request: id, p_command: randomUUID(), p_body: 'Denied' })).error?.code, '42501')
  assert.ifError((await operator.session.rpc('set_outreach_comment_status', { p_client: EPM, p_request: id, p_version: 5, p_status: 'in_progress' })).error)
  assert.ifError((await owner.session.rpc('set_outreach_comment_status', { p_client: EPM, p_request: id, p_version: 6, p_status: 'resolved' })).error)
  assert.equal((await detail(f.supabase, id)).request.status, 'resolved')
})

test('author identity comes from the session and content is plain text without raw table access', async (t) => {
  const f = await fixture(t)
  const member = await f.person('client_member')
  const id = await create(member.session, randomUUID(), 'A markup request', '<script>alert("x")</script>\nKeep this literal.')
  const saved = await detail(f.supabase, id)
  assert.equal(saved.request.authorName, 'Actual authenticated author')
  assert.equal(saved.request.body, '<script>alert("x")</script>\nKeep this literal.')
  const raw = await admin.from('outreach_comment_requests').select('author_user_id').eq('id', id).single()
  assert.equal(raw.data?.author_user_id, member.user.id)
  for (const table of ['outreach_comment_settings','outreach_comment_requests','outreach_comment_messages','outreach_comment_commands'] as const) {
    assert.ok((await f.supabase.from(table).select('*')).error)
    assert.ok((await anonClient().from(table).select('*')).error)
  }
  assert.equal(JSON.stringify(saved).includes(member.user.id), false)
})

test('foreign and unassigned users cannot read or mutate any EPM thread or infer unknown thread identities', async (t) => {
  const f = await fixture(t)
  const id = await create(f.supabase)
  const foreign = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(foreign.user.id, foreign.client.id, 'operator')
  const stranger = await f.person()
  for (const session of [foreign.supabase, stranger.session]) {
    assert.equal((await session.rpc('list_outreach_comments', { p_client: EPM })).error?.code, '42501')
    assert.equal((await session.rpc('get_outreach_comment', { p_client: EPM, p_request: id })).error?.code, '42501')
    assert.equal((await session.rpc('reply_outreach_comment', { p_client: EPM, p_request: id, p_command: randomUUID(), p_body: 'Denied' })).error?.code, '42501')
    assert.equal((await session.rpc('set_outreach_comment_status', { p_client: EPM, p_request: id, p_version: 1, p_status: 'resolved' })).error?.code, '42501')
  }
  assert.equal((await f.supabase.rpc('get_outreach_comment', { p_client: EPM, p_request: randomUUID() })).error?.code, '42501')
  assert.equal((await f.supabase.rpc('get_outreach_comment', { p_client: foreign.client.id, p_request: id })).error?.code, '42501')
})

test('concurrent same-command creates and replies commit once; changed content or command kind conflicts', async (t) => {
  const f = await fixture(t)
  const command = randomUUID()
  const ids = await Promise.all(Array.from({ length: 8 }, () => create(f.supabase, command)))
  assert.equal(new Set(ids).size, 1)
  const id = ids[0]
  assert.equal((await f.supabase.rpc('create_outreach_comment', { p_client: EPM, p_command: command, p_title: 'Different', p_body: 'Different' })).error?.code, '40001')
  assert.equal((await f.supabase.rpc('reply_outreach_comment', { p_client: EPM, p_request: id, p_command: command, p_body: 'Text' })).error?.code, '40001')
  const replyCommand = randomUUID()
  const replies = await Promise.all(Array.from({ length: 8 }, () => f.supabase.rpc('reply_outreach_comment', { p_client: EPM, p_request: id, p_command: replyCommand, p_body: 'Only once' })))
  for (const reply of replies) { assert.ifError(reply.error); assert.equal(reply.data, id) }
  assert.equal((await detail(f.supabase, id)).request.replyCount, 1)
  assert.equal((await detail(f.supabase, id)).messages.length, 1)
  assert.equal((await f.supabase.rpc('reply_outreach_comment', { p_client: EPM, p_request: id, p_command: replyCommand, p_body: 'Changed text' })).error?.code, '40001')
  const second = await create(f.supabase)
  assert.equal((await f.supabase.rpc('reply_outreach_comment', { p_client: EPM, p_request: second, p_command: replyCommand, p_body: 'Only once' })).error?.code, '40001')
})

test('replays recheck revoked membership and disabled feature before returning durable receipts', async (t) => {
  const f = await fixture(t)
  const member = await f.person('client_member')
  const command = randomUUID()
  const id = await create(member.session, command)
  assert.ifError((await admin.from('outreach_memberships').update({ state: 'revoked' }).eq('client_id', EPM).eq('user_id', member.user.id)).error)
  assert.equal((await member.session.rpc('create_outreach_comment', { p_client: EPM, p_command: command, p_title: 'Please change the template', p_body: 'This is a real saved request.' })).error?.code, '42501')
  assert.equal((await member.session.rpc('get_outreach_comment', { p_client: EPM, p_request: id })).error?.code, '42501')
  assert.ifError((await admin.from('outreach_comment_settings').update({ enabled: false }).eq('client_id', EPM)).error)
  assert.equal((await f.supabase.rpc('get_outreach_comment', { p_client: EPM, p_request: id })).error?.code, '42501')
  assert.equal((await f.supabase.rpc('reply_outreach_comment', { p_client: EPM, p_request: id, p_command: randomUUID(), p_body: 'Disabled' })).error?.code, '42501')
  const hidden = await f.supabase.rpc('list_outreach_comments', { p_client: EPM })
  assert.deepEqual((hidden.data as { requests: unknown[] }).requests, [])
  assert.ifError((await admin.from('client_features').update({ enabled: false }).eq('client_id', EPM)).error)
  assert.equal((await f.supabase.rpc('list_outreach_comments', { p_client: EPM })).error?.code, '42501')
})

test('concurrent status edits and replies fence stale versions without losing a reply', async (t) => {
  const f = await fixture(t)
  const operator = await f.person('operator')
  const id = await create(f.supabase)
  const results = await Promise.all(['resolved', 'in_progress'].map((status) => operator.session.rpc('set_outreach_comment_status', { p_client: EPM, p_request: id, p_version: 1, p_status: status })))
  assert.equal(results.filter((r) => !r.error).length, 1)
  assert.equal(results.filter((r) => r.error?.code === '40001').length, 1)
  assert.ifError((await f.supabase.rpc('reply_outreach_comment', { p_client: EPM, p_request: id, p_command: randomUUID(), p_body: 'Still needed' })).error)
  assert.equal((await operator.session.rpc('set_outreach_comment_status', { p_client: EPM, p_request: id, p_version: 2, p_status: 'open' })).error?.code, '40001')
  assert.equal((await detail(f.supabase, id)).request.version, 3)
  assert.equal((await detail(f.supabase, id)).request.replyCount, 1)
})

test('request and message pagination is bounded and replies/status changes do not reorder request pages', async (t) => {
  const f = await fixture(t)
  const ids: string[] = []
  for (let n = 0; n < 27; n++) ids.push(await create(f.supabase, randomUUID(), `Request ${n}`))
  const first = await f.supabase.rpc('list_outreach_comments', { p_client: EPM })
  // Activity on an older request between reads must not move it onto an already
  // consumed page, which would lose a request and repeat another at the boundary.
  const owner = await f.person('owner')
  assert.ifError((await f.supabase.rpc('reply_outreach_comment', { p_client: EPM, p_request: ids[0], p_command: randomUUID(), p_body: 'Between pages' })).error)
  assert.ifError((await owner.session.rpc('set_outreach_comment_status', { p_client: EPM, p_request: ids[0], p_version: 2, p_status: 'in_progress' })).error)
  const next = await f.supabase.rpc('list_outreach_comments', { p_client: EPM, p_offset: 25 })
  assert.ifError(first.error); assert.ifError(next.error)
  const a = first.data as { requests: { id: string }[]; hasMore: boolean }
  const b = next.data as { requests: { id: string }[]; hasMore: boolean }
  assert.equal(a.requests.length, 25); assert.equal(a.hasMore, true)
  assert.equal(b.requests.length, 2); assert.equal(b.hasMore, false)
  assert.deepEqual([...a.requests, ...b.requests].map((r) => r.id), ids.toReversed())
  for (let n = 0; n < 27; n++) assert.ifError((await f.supabase.rpc('reply_outreach_comment', { p_client: EPM, p_request: ids[0], p_command: randomUUID(), p_body: `Reply ${n}` })).error)
  const d1 = await detail(f.supabase, ids[0]); const d2 = await detail(f.supabase, ids[0], 25)
  assert.equal(d1.messages.length, 25); assert.equal(d1.hasMore, true)
  assert.equal(d2.messages.length, 3); assert.equal(d2.hasMore, false)
  assert.deepEqual([...d1.messages, ...d2.messages].map((m) => m.body), ['Between pages', ...Array.from({ length: 27 }, (_, n) => `Reply ${n}`)])
  const latest = await f.supabase.rpc('list_outreach_comments', { p_client: EPM })
  assert.equal((latest.data as { requests: { id: string }[] }).requests[0].id, ids[26])
  assert.ifError((await owner.session.rpc('set_outreach_comment_status', { p_client: EPM, p_request: ids[0], p_version: 30, p_status: 'resolved' })).error)
  const resolved = await f.supabase.rpc('list_outreach_comments', { p_client: EPM, p_status: 'resolved' })
  assert.deepEqual((resolved.data as { requests: { id: string }[] }).requests.map((r) => r.id), [ids[0]])
  assert.equal((await f.supabase.rpc('get_outreach_comment', { p_client: EPM, p_request: ids[0], p_offset: -1 })).error?.code, '22023')
})

test('database text/status bounds apply even when bypassing the HTTP adapter', async (t) => {
  const f = await fixture(t)
  for (const [title, body] of [['', 'Text'], ['x'.repeat(121), 'Text'], ['Title', ' '], ['Title', 'x'.repeat(5001)],
    ['\n\t\r', 'Text'], ['\u00a0\ufeff', 'Text'], ['Title', '\n\u00a0\ufeff'], ['Title', '😀'.repeat(3000)], ['😀'.repeat(61), 'Text']]) {
    assert.equal((await f.supabase.rpc('create_outreach_comment', { p_client: EPM, p_command: randomUUID(), p_title: title, p_body: body })).error?.code, '22023')
  }
  const id = await create(f.supabase, randomUUID(), 'Valid Unicode', '界'.repeat(5000))
  assert.equal((await detail(f.supabase, id)).request.body.length, 5000)
  assert.equal((await f.supabase.rpc('reply_outreach_comment', { p_client: EPM, p_request: id, p_command: randomUUID(), p_body: 'x'.repeat(5001) })).error?.code, '22023')
  assert.equal((await f.supabase.rpc('reply_outreach_comment', { p_client: EPM, p_request: id, p_command: randomUUID(), p_body: '😀'.repeat(3000) })).error?.code, '22023')
  assert.equal((await f.supabase.rpc('reply_outreach_comment', { p_client: EPM, p_request: id, p_command: randomUUID(), p_body: '\n\u00a0\ufeff' })).error?.code, '22023')
  const emoji = await create(f.supabase, randomUUID(), 'Emoji boundary', '😀'.repeat(2500))
  assert.equal((await detail(f.supabase, emoji)).request.body.length, 5000)
  const command = randomUUID()
  const normalized = await create(f.supabase, command, '\n\u00a0 Title \ufeff', '\t Body \r\n')
  assert.equal(await create(f.supabase, command, 'Title', 'Body'), normalized)
  assert.equal((await detail(f.supabase, normalized)).request.body, 'Body')
  const owner = await f.person('owner')
  assert.equal((await owner.session.rpc('set_outreach_comment_status', { p_client: EPM, p_request: id, p_version: 1, p_status: 'deleted' })).error?.code, '22023')
})
