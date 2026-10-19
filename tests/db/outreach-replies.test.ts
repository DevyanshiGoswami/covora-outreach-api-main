import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test, type TestContext } from 'node:test'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { createTenant, createUser } from '../helpers/tenants.ts'
import { grantOutreachMembership, grantOutreachOwner, grantAgencyControls } from '../helpers/outreach.ts'

type Command = { id: string; status: string; bodyText: string }
type Detail = { id: string; version: number; latestMessageId: string; latestAt: string; owner: { kind: string; userId: string | null; name: string }; ownedByMe: boolean; canTakeover: boolean; canReply: boolean; unread: boolean; messages: { id: string }[]; commands: Command[] }
type Claim = { claimToken: string; context: Record<string, string | null> }
const admin = adminClient()
async function fixture(t: TestContext, channel: 'email' | 'linkedin' = 'email') {
  const a = await createTenant(null, { features: ['outreach_app'] })
  const b = await createTenant(null, { features: ['outreach_app'] })
  const people: Awaited<ReturnType<typeof createUser>>[] = []
  t.after(async () => { await a.cleanup(); await b.cleanup(); for (const p of people) assert.ifError((await admin.auth.admin.deleteUser(p.user.id)).error) })
  await grantOutreachMembership(a.user.id, a.client.id, 'client_admin')
  await grantOutreachMembership(b.user.id, b.client.id, 'client_member')
  async function person(role: 'operator' | 'client_member' | 'client_viewer' | 'owner') {
    const p = await createUser({ clientId: null }); people.push(p)
    if (role === 'owner') await grantOutreachOwner(p.user.id)
    else await grantOutreachMembership(p.user.id, a.client.id, role)
    return p
  }
  const campaign = channel === 'linkedin' ? await admin.from('outreach_campaigns').insert({
    client_id: a.client.id, channel: 'linkedin', provider_campaign_id: String(Math.floor(Math.random() * 1_000_000_000) + 1), name: 'Approved synthetic LinkedIn campaign',
  }).select('id,provider_campaign_id').single() : null
  if (campaign) assert.ifError(campaign.error)
  const workspace = await admin.from('outreach_reply_workspaces').insert({ client_id: a.client.id, channel, remote_workspace_id: randomUUID(), credential_ref: `OUTREACH_${channel === 'email' ? 'INSTANTLY' : 'HEYREACH'}_TEST_${randomUUID().replaceAll('-', '').toUpperCase()}`, enabled: true }).select('*').single()
  assert.ifError(workspace.error)
  const emailSender = `sender-${randomUUID()}@example.test`
  const sender = await admin.from('outreach_reply_senders').insert({ client_id: a.client.id, channel, workspace_id: workspace.data!.id, remote_sender_id: channel === 'email' ? emailSender : `sender-${randomUUID()}`, sender_address: channel === 'email' ? emailSender : 'sender@example.test', sender_label: 'Workspace sender', enabled: true }).select('*').single()
  assert.ifError(sender.error)
  const thread = await admin.from('outreach_conversations').insert({ client_id: a.client.id, channel, campaign_id: campaign?.data?.id ?? null, sender_id: sender.data!.id, remote_conversation_id: randomUUID(), contact_name: 'Prospect', contact_address: 'prospect@example.test', subject: 'Hello' }).select('*').single()
  assert.ifError(thread.error)
  const message = await admin.from('outreach_conversation_messages').insert({ client_id: a.client.id, conversation_id: thread.data!.id, remote_message_id: randomUUID(), remote_fingerprint: channel === 'linkedin' ? 'fingerprint-first' : null, direction: 'received', body_text: 'Can you tell me more?', sent_at: new Date().toISOString(), sender_label: 'Prospect' }).select('*').single()
  assert.ifError(message.error)
  async function detail(session = a.supabase) { const result = await session.rpc('read_outreach_conversation', { p_client_id: a.client.id, p_conversation_id: thread.data!.id }); assert.ifError(result.error); return result.data as unknown as Detail }
  async function enqueue(session = a.supabase, extra: Record<string, unknown> = {}) { const d = await detail(); return session.rpc('enqueue_outreach_reply', { p_client_id: a.client.id, p_conversation_id: thread.data!.id, p_command_id: randomUUID(), p_expected_version: d.version, p_latest_message_id: d.latestMessageId, p_body: 'Happy to help.', p_takeover: true, ...extra }) }
  return { a, b, person, workspace: workspace.data!, sender: sender.data!, campaign: campaign?.data ?? null, conversation: thread.data!, message: message.data!, detail, enqueue }
}

test('client removal fences queued/preparing replies and preserves uncertain history', async t => {
  for (const status of ['queued', 'preparing', 'unknown'] as const) {
    const f = await fixture(t)
    const owner = await f.person('owner'); await grantAgencyControls(owner.user.id)
    const queued = await f.enqueue(); assert.ifError(queued.error)
    const id = (queued.data as unknown as Command).id
    const claim = status === 'queued' ? null : await admin.rpc('claim_outreach_reply', { p_command_id: id })
    if (claim) assert.ifError(claim.error)
    if (status === 'unknown') assert.ifError((await admin.from('outreach_reply_commands').update({ status: 'unknown' }).eq('id', id)).error)
    assert.ifError((await owner.session.rpc('remove_outreach_client', { p_client_id: f.a.client.id, p_name: f.a.client.name })).error)
    assert.equal((await admin.from('outreach_reply_commands').select('status').eq('id', id).single()).data?.status, status === 'unknown' ? 'unknown' : 'cancelled')
    if (claim) assert.equal((await admin.rpc('dispatch_outreach_reply', { p_command_id: id, p_claim_token: (claim.data as unknown as Claim).claimToken })).data, false)
    else assert.equal((await admin.rpc('claim_outreach_reply', { p_command_id: id })).data, null)
    assert.deepEqual((await admin.from('outreach_reply_workspaces').select('enabled,sync_enabled').eq('id', f.workspace.id).single()).data, { enabled: false, sync_enabled: false })
    assert.equal((await admin.from('outreach_conversation_messages').select('id').eq('id', f.message.id)).data?.length, 1)
  }
})
test('client removal refuses an active dispatch without partially revoking access', async t => {
  const f = await fixture(t); const owner = await f.person('owner'); await grantAgencyControls(owner.user.id)
  const queued = await f.enqueue(); assert.ifError(queued.error)
  const id = (queued.data as unknown as Command).id
  const claim = await admin.rpc('claim_outreach_reply', { p_command_id: id }); assert.ifError(claim.error)
  assert.equal((await admin.rpc('dispatch_outreach_reply', { p_command_id: id, p_claim_token: (claim.data as unknown as Claim).claimToken })).data, true)
  assert.equal((await owner.session.rpc('remove_outreach_client', { p_client_id: f.a.client.id, p_name: f.a.client.name })).error?.code, '55000')
  assert.equal((await admin.from('client_features').select('enabled').eq('client_id', f.a.client.id).single()).data?.enabled, true)
  assert.equal((await admin.from('outreach_memberships').select('state').eq('client_id', f.a.client.id).eq('user_id', f.a.user.id).single()).data?.state, 'active')
})

test('preview workspaces deny replies despite real bindings, and recheck preview before claim and dispatch', async t => {
  for (const channel of ['email', 'linkedin'] as const) {
    const f = await fixture(t, channel)
    const setPreview = async (preview: boolean) => assert.ifError((await admin.from('client_features')
      .update({ config: { presentation_mode: preview ? 'preview' : 'live' } }).eq('client_id',f.a.client.id).eq('feature','outreach_app')).error)
    await setPreview(true)
    const detail = await f.detail()
    assert.equal(detail.canReply,false)
    assert.equal(detail.canTakeover,false)
    assert.equal((await f.enqueue()).error?.code,'42501')
    const owner = await f.person('owner')
    assert.equal((await f.enqueue(owner.session)).error?.code,'42501')
    await setPreview(false)
    const queued = await f.enqueue()
    assert.ifError(queued.error)
    await setPreview(true)
    const refused = await admin.rpc('claim_outreach_reply',{p_command_id:(queued.data as unknown as Command).id})
    assert.ifError(refused.error)
    assert.equal(refused.data,null)
    await setPreview(false)
    const queuedAgain = await f.enqueue()
    assert.ifError(queuedAgain.error)
    const claimed = await admin.rpc('claim_outreach_reply',{p_command_id:(queuedAgain.data as unknown as Command).id})
    assert.ifError(claimed.error)
    assert.ok(claimed.data)
    await setPreview(true)
    const dispatch = await admin.rpc('dispatch_outreach_reply',{p_command_id:(queuedAgain.data as unknown as Command).id,p_claim_token:(claimed.data as unknown as Claim).claimToken})
    assert.ifError(dispatch.error)
    assert.equal(dispatch.data,false)
    assert.equal((await admin.from('outreach_reply_commands').select('id').eq('client_id',f.a.client.id).eq('status','sending')).data?.length,0)
  }
})

test('conversation projections are tenant-private and viewers cannot claim or reply', async (t) => {
  const f = await fixture(t); const viewer = await f.person('client_viewer')
  const d = await f.detail()
  assert.deepEqual(d.owner, { kind: 'covora', userId: null, name: 'Covora' }); assert.equal(d.ownedByMe, false)
  assert.equal(d.canTakeover, true); assert.equal(d.messages.length, 1); assert.equal(d.unread, true)
  for (const secret of [f.workspace.credential_ref, f.workspace.remote_workspace_id, f.sender.remote_sender_id, f.message.remote_message_id]) assert.equal(JSON.stringify(d).includes(secret), false)
  for (const table of ['outreach_reply_workspaces', 'outreach_reply_senders', 'outreach_conversations', 'outreach_conversation_messages', 'outreach_reply_commands', 'outreach_conversation_reads'] as const) assert.ok((await f.a.supabase.from(table).select('*')).error)
  for (const session of [f.b.supabase, anonClient()]) assert.ok((await session.rpc('read_outreach_conversation', { p_client_id: f.a.client.id, p_conversation_id: f.conversation.id })).error)
  const vd = await f.detail(viewer.session); assert.equal(vd.canReply, false); assert.equal(vd.canTakeover, false)
  assert.ok((await f.enqueue(viewer.session)).error)
  assert.ok((await viewer.session.rpc('change_outreach_conversation_owner', { p_client_id: f.a.client.id, p_conversation_id: f.conversation.id, p_expected_version: d.version, p_owner: 'me' })).error)
})

test('takeover is immediate but stale ownership and missing takeover consent cannot enqueue', async (t) => {
  const f = await fixture(t); const member = await f.person('client_member'); const d = await f.detail()
  assert.ok((await f.enqueue(f.a.supabase, { p_takeover: false })).error)
  const claim = await member.session.rpc('change_outreach_conversation_owner', { p_client_id: f.a.client.id, p_conversation_id: f.conversation.id, p_expected_version: d.version, p_owner: 'me' })
  assert.ifError(claim.error); assert.equal((claim.data as unknown as Detail).owner.userId, member.user.id)
  assert.ok((await f.enqueue(f.a.supabase, { p_expected_version: d.version })).error)
  assert.ok((await f.a.supabase.rpc('change_outreach_conversation_owner', { p_client_id: f.a.client.id, p_conversation_id: f.conversation.id, p_expected_version: (claim.data as unknown as Detail).version, p_owner: 'covora' })).error)
  const returned = await member.session.rpc('change_outreach_conversation_owner', { p_client_id: f.a.client.id, p_conversation_id: f.conversation.id, p_expected_version: (claim.data as unknown as Detail).version, p_owner: 'covora' })
  assert.ifError(returned.error); assert.equal((returned.data as unknown as Detail).owner.kind, 'covora')
})

test('reply idempotency binds actor, conversation and body and repeated clicks create one command', async (t) => {
  const f = await fixture(t); const member = await f.person('client_member'); const d = await f.detail(); const commandId = randomUUID()
  const input = { p_command_id: commandId, p_expected_version: d.version, p_latest_message_id: d.latestMessageId }
  const raced = await Promise.all([f.enqueue(f.a.supabase, input), f.enqueue(f.a.supabase, input)])
  raced.forEach(r => assert.ifError(r.error)); assert.equal((raced[0].data as Command).id, commandId); assert.equal((raced[1].data as Command).id, commandId)
  assert.equal((await f.detail()).commands.length, 1)
  assert.ok((await f.enqueue(f.a.supabase, { ...input, p_body: 'Different text' })).error)
  assert.ok((await f.enqueue(member.session, input)).error)
  assert.ok((await f.enqueue(f.a.supabase, { p_command_id: randomUUID() })).error)
})

test('a new inbound message or immediate takeover invalidates an undispatched command', async (t) => {
  const f = await fixture(t); const member = await f.person('client_member'); const queued = await f.enqueue(); assert.ifError(queued.error)
  const id = (queued.data as Command).id
  const claim = await admin.rpc('claim_outreach_reply', { p_command_id: id }); assert.ifError(claim.error); assert.ok(claim.data)
  const d = await f.detail()
  const taken = await member.session.rpc('change_outreach_conversation_owner', { p_client_id: f.a.client.id, p_conversation_id: f.conversation.id, p_expected_version: d.version, p_owner: 'me' })
  assert.ifError(taken.error); assert.equal((taken.data as unknown as Detail).owner.userId, member.user.id)
  assert.equal((await admin.rpc('dispatch_outreach_reply', { p_command_id: id, p_claim_token: (claim.data as Claim).claimToken })).data, false)
  assert.equal((await f.detail()).commands[0].status, 'failed')
  const next = await f.enqueue(member.session); assert.ifError(next.error)
  assert.ifError((await admin.from('outreach_conversation_messages').insert({ client_id: f.a.client.id, conversation_id: f.conversation.id, remote_message_id: randomUUID(), direction: 'received', body_text: 'One more question', sender_label: 'Prospect', sent_at: new Date(Date.now() + 1000).toISOString() })).error)
  assert.equal((await admin.rpc('claim_outreach_reply', { p_command_id: (next.data as Command).id })).data, null)
})

test('dispatch checks current membership and binding versions after preparation', async (t) => {
  const f = await fixture(t); const queued = await f.enqueue(); assert.ifError(queued.error); const id = (queued.data as Command).id
  const claim = await admin.rpc('claim_outreach_reply', { p_command_id: id }); assert.ifError(claim.error)
  assert.ifError((await admin.from('outreach_reply_senders').update({ sender_label: 'Changed binding' }).eq('id', f.sender.id)).error)
  assert.equal((await admin.rpc('dispatch_outreach_reply', { p_command_id: id, p_claim_token: (claim.data as Claim).claimToken })).data, false)
  const next = await f.enqueue(); assert.ifError(next.error); const nextId = (next.data as Command).id
  const nextClaim = await admin.rpc('claim_outreach_reply', { p_command_id: nextId }); assert.ifError(nextClaim.error)
  assert.ifError((await admin.from('outreach_memberships').update({ state: 'revoked' }).eq('client_id', f.a.client.id).eq('user_id', f.a.user.id)).error)
  assert.equal((await admin.rpc('dispatch_outreach_reply', { p_command_id: nextId, p_claim_token: (nextClaim.data as Claim).claimToken })).data, false)
})

test('dispatched unknown outcomes never retry but ownership can change and a confirmed result remains durable', async (t) => {
  const f = await fixture(t); const member = await f.person('client_member'); const queued = await f.enqueue(); assert.ifError(queued.error); const id = (queued.data as Command).id
  for (const session of [f.a.supabase, f.b.supabase, anonClient()]) assert.ok((await session.rpc('claim_outreach_reply', { p_command_id: id })).error)
  const claim = await admin.rpc('claim_outreach_reply', { p_command_id: id }); assert.ifError(claim.error); const token = (claim.data as Claim).claimToken
  assert.equal((await admin.rpc('dispatch_outreach_reply', { p_command_id: id, p_claim_token: token })).data, true)
  assert.equal((await admin.rpc('dispatch_outreach_reply', { p_command_id: id, p_claim_token: token })).data, false)
  const d = await f.detail(); assert.equal(d.canTakeover, true); assert.equal(d.canReply, false); assert.equal(d.commands[0].status, 'sending')
  assert.ifError((await member.session.rpc('change_outreach_conversation_owner', { p_client_id: f.a.client.id, p_conversation_id: f.conversation.id, p_expected_version: d.version, p_owner: 'me' })).error)
  assert.equal((await admin.rpc('finish_outreach_reply', { p_command_id: id, p_claim_token: token, p_status: 'unknown' })).data, true)
  assert.equal((await admin.rpc('claim_outreach_reply', { p_command_id: id })).data, null)
  assert.ok((await f.enqueue(member.session)).error)
  assert.equal((await f.detail()).commands[0].status, 'unknown')
  assert.equal((await admin.rpc('finish_outreach_reply', { p_command_id: id, p_claim_token: token, p_status: 'sent', p_remote_message_id: 'confirmed-after-timeout' })).data, true)
  assert.equal((await f.detail()).commands[0].status, 'sent')
  assert.ifError((await f.enqueue(member.session)).error)
})

test('local read state is per-user and channel filtering occurs before keyset pagination', async (t) => {
  const f = await fixture(t); const member = await f.person('client_member')
  assert.ifError((await f.a.supabase.rpc('mark_outreach_conversation_read', { p_client_id: f.a.client.id, p_conversation_id: f.conversation.id })).error)
  assert.equal((await f.detail()).unread, false); assert.equal((await f.detail(member.session)).unread, true)
  const own = await f.a.supabase.rpc('list_outreach_conversations', { p_client_id: f.a.client.id, p_channel: 'email', p_limit: 1 })
  assert.ifError(own.error); assert.equal((own.data as unknown as Detail[]).length, 1)
  const row = (own.data as unknown as Detail[])[0]
  const next = await f.a.supabase.rpc('list_outreach_conversations', { p_client_id: f.a.client.id, p_channel: 'email', p_limit: 1, p_before_at: row.latestAt, p_before_id: row.id })
  assert.ifError(next.error); assert.deepEqual(next.data, [])
  assert.deepEqual((await f.a.supabase.rpc('list_outreach_conversations', { p_client_id: f.a.client.id, p_channel: 'linkedin' })).data, [])
})

test('takeover and enqueue atomically supersede a queued owner command', async (t) => {
  const f = await fixture(t); const member = await f.person('client_member')
  const original = await f.enqueue(); assert.ifError(original.error)
  const replacement = await f.enqueue(member.session); assert.ifError(replacement.error)
  const d = await f.detail(); assert.equal(d.owner.userId, member.user.id)
  assert.deepEqual(d.commands.map(c => c.status), ['failed', 'pending'])
  assert.equal((await admin.rpc('claim_outreach_reply', { p_command_id: (original.data as Command).id })).data, null)
  assert.ok((await admin.rpc('claim_outreach_reply', { p_command_id: (replacement.data as Command).id })).data)
})

test('expired preparation fails permanently while expired dispatch becomes unknown and blocks another send', async (t) => {
  const f = await fixture(t)
  const first = await f.enqueue(); assert.ifError(first.error); const firstId = (first.data as Command).id
  const preparation = await admin.rpc('claim_outreach_reply', { p_command_id: firstId }); assert.ifError(preparation.error)
  assert.ifError((await admin.from('outreach_reply_commands').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', firstId)).error)
  assert.equal((await admin.rpc('dispatch_outreach_reply', { p_command_id: firstId, p_claim_token: (preparation.data as Claim).claimToken })).data, false)
  assert.equal((await admin.rpc('claim_outreach_reply', { p_command_id: firstId })).data, null)
  assert.equal((await f.detail()).commands[0].status, 'failed')
  const second = await f.enqueue(); assert.ifError(second.error); const secondId = (second.data as Command).id
  const sending = await admin.rpc('claim_outreach_reply', { p_command_id: secondId }); assert.ifError(sending.error)
  assert.equal((await admin.rpc('dispatch_outreach_reply', { p_command_id: secondId, p_claim_token: (sending.data as Claim).claimToken })).data, true)
  assert.ifError((await admin.from('outreach_reply_commands').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', secondId)).error)
  assert.equal((await f.detail()).commands[1].status, 'unknown')
  assert.equal((await admin.rpc('claim_outreach_reply', { p_command_id: secondId })).data, null)
  assert.ok((await f.enqueue()).error)
})

test('disabled replies preserve takeover and intent rejects oversized Unicode or mutable payloads', async (t) => {
  const f = await fixture(t)
  assert.ok((await f.enqueue(f.a.supabase, { p_body: '😀'.repeat(4001) })).error)
  const queued = await f.enqueue(f.a.supabase, { p_body: `  ${'😀'.repeat(4000)}  ` }); assert.ifError(queued.error)
  assert.equal((queued.data as Command).bodyText, '😀'.repeat(4000))
  assert.ok((await admin.from('outreach_reply_commands').update({ body_text: 'Changed intent' }).eq('id', (queued.data as Command).id)).error)
  assert.ifError((await admin.from('outreach_reply_workspaces').update({ enabled: false }).eq('id', f.workspace.id)).error)
  const d = await f.detail(); assert.equal(d.canTakeover, true); assert.equal(d.canReply, false)
  assert.equal((await admin.rpc('claim_outreach_reply', { p_command_id: (queued.data as Command).id })).data, null)
  const member = await f.person('client_member')
  assert.ifError((await member.session.rpc('change_outreach_conversation_owner', { p_client_id: f.a.client.id, p_conversation_id: f.conversation.id, p_expected_version: d.version, p_owner: 'me' })).error)
})

test('LinkedIn sync is tenant-bound, idempotent and deterministic for equal-time fingerprints', async (t) => {
  const f = await fixture(t, 'linkedin'); const time = new Date().toISOString()
  assert.ifError((await admin.from('outreach_reply_workspaces').update({ sync_enabled: true }).eq('id', f.workspace.id)).error)
  const input = { p_sender_id: f.sender.id, p_campaign_id: f.campaign!.id, p_remote_campaign_id: f.campaign!.provider_campaign_id, p_sender_version: f.sender.version, p_workspace_version: f.workspace.version, p_remote_conversation_id: randomUUID(), p_contact_name: 'LinkedIn prospect', p_contact_address: 'https://linkedin.com/in/prospect', p_subject: '', p_messages: [
    { fingerprint: 'fingerprint-z', direction: 'received', bodyText: 'Latest tie', sentAt: time, senderLabel: 'Prospect' },
    { fingerprint: 'fingerprint-a', direction: 'sent', bodyText: 'Earlier tie', sentAt: time, senderLabel: 'Workspace sender' },
  ] }
  assert.ok((await f.a.supabase.rpc('sync_outreach_linkedin_conversation', input)).error)
  assert.ok((await anonClient().rpc('sync_outreach_linkedin_conversation', input)).error)
  const synced = await admin.rpc('sync_outreach_linkedin_conversation', input); assert.ifError(synced.error)
  const read = async () => { const r = await f.a.supabase.rpc('read_outreach_conversation', { p_client_id: f.a.client.id, p_conversation_id: synced.data! }); assert.ifError(r.error); return r.data as unknown as Detail }
  const first = await read(); assert.equal(first.messages.length, 2)
  assert.ifError((await admin.rpc('sync_outreach_linkedin_conversation', input)).error)
  const repeat = await read(); assert.equal(repeat.version, first.version); assert.equal(repeat.latestMessageId, first.latestMessageId)
  const queued = await f.a.supabase.rpc('enqueue_outreach_reply', { p_client_id: f.a.client.id, p_conversation_id: first.id, p_command_id: randomUUID(), p_expected_version: first.version, p_latest_message_id: first.latestMessageId, p_body: 'Reply', p_takeover: true }); assert.ifError(queued.error)
  const claim = await admin.rpc('claim_outreach_reply', { p_command_id: (queued.data as Command).id }); assert.ifError(claim.error)
  assert.equal((claim.data as Claim).context.latestMessageFingerprint, 'fingerprint-z')
  assert.ok((await f.b.supabase.rpc('read_outreach_conversation', { p_client_id: f.b.client.id, p_conversation_id: first.id })).error)
  assert.ifError((await admin.from('outreach_reply_senders').update({ sync_cursor: 'next', synced_at: new Date().toISOString() }).eq('id', f.sender.id)).error)
  assert.equal((await admin.rpc('dispatch_outreach_reply', { p_command_id: (queued.data as Command).id, p_claim_token: (claim.data as Claim).claimToken })).data, true)
})

test('sync control is independent from sending and disabled feature rejects service imports', async (t) => {
  const f = await fixture(t, 'linkedin')
  const input = { p_sender_id: f.sender.id, p_campaign_id: f.campaign!.id, p_remote_campaign_id: f.campaign!.provider_campaign_id, p_sender_version: f.sender.version, p_workspace_version: f.workspace.version, p_remote_conversation_id: randomUUID(), p_contact_name: 'Prospect', p_contact_address: 'profile', p_subject: '', p_messages: [] }
  const workspace = await admin.from('outreach_reply_workspaces').select('version,sync_enabled').eq('id', f.workspace.id).single()
  assert.ifError(workspace.error); assert.equal(workspace.data!.sync_enabled, false)
  assert.ok((await admin.rpc('sync_outreach_linkedin_conversation', input)).error)
  assert.ifError((await admin.from('outreach_reply_workspaces').update({ sync_enabled: true }).eq('id', f.workspace.id)).error)
  const updated = await admin.from('outreach_reply_workspaces').select('version').eq('id', f.workspace.id).single()
  assert.equal(updated.data!.version, workspace.data!.version)
  assert.ifError((await admin.from('outreach_reply_workspaces').update({ enabled: false }).eq('id', f.workspace.id)).error)
  input.p_workspace_version = (await admin.from('outreach_reply_workspaces').select('version').eq('id', f.workspace.id).single()).data!.version
  assert.ifError((await admin.rpc('sync_outreach_linkedin_conversation', input)).error)
  assert.ifError((await admin.from('client_features').update({ enabled: false }).eq('client_id', f.a.client.id).eq('feature', 'outreach_app')).error)
  assert.equal((await admin.rpc('sync_outreach_linkedin_conversation', input)).error?.code, '42501')
})

test('email bridge keeps neutral interest and exact reply target; purging original history also purges commands', async (t) => {
  const f = await fixture(t)
  const campaign = await admin.from('outreach_campaigns').insert({ client_id: f.a.client.id, provider_campaign_id: randomUUID(), name: 'Email campaign' }).select('id,provider_campaign_id').single(); assert.ifError(campaign.error)
  const source = await admin.from('outreach_messages').insert({ client_id: f.a.client.id, campaign_id: campaign.data!.id, provider_email_id: randomUUID(), provider_thread_id: randomUUID(), provider_account: f.sender.remote_sender_id, thread_key: randomUUID(), direction: 'received', lead_email: 'prospect@example.test', from_email: 'prospect@example.test', to_email: f.sender.remote_sender_id, subject: 'Source message', body_text: 'Interested', interest: 'interested', sent_at: new Date().toISOString() }).select('*').single(); assert.ifError(source.error)
  const conversation = await admin.from('outreach_conversations').select('id').eq('campaign_id', campaign.data!.id).single(); assert.ifError(conversation.error)
  const read = async () => { const r = await f.a.supabase.rpc('read_outreach_conversation', { p_client_id: f.a.client.id, p_conversation_id: conversation.data!.id }); assert.ifError(r.error); return r.data as unknown as Detail & { interest: string } }
  const detail = await read(); assert.equal(detail.interest, 'interested'); assert.equal(detail.messages.length, 1)
  assert.ifError((await admin.from('outreach_messages').update({ client_read_at: new Date().toISOString() }).eq('id', source.data!.id)).error)
  assert.equal((await read()).version, detail.version); assert.equal((await read()).unread, true)
  const queued = await f.a.supabase.rpc('enqueue_outreach_reply', { p_client_id: f.a.client.id, p_conversation_id: detail.id, p_command_id: randomUUID(), p_expected_version: detail.version, p_latest_message_id: detail.latestMessageId, p_body: 'Thanks', p_takeover: true }); assert.ifError(queued.error)
  const claim = await admin.rpc('claim_outreach_reply', { p_command_id: (queued.data as Command).id }); assert.ifError(claim.error)
  const context = (claim.data as Claim).context
  assert.equal(context.remoteCampaignId, campaign.data!.provider_campaign_id); assert.equal(context.remoteReplyToId, source.data!.provider_email_id); assert.equal(context.remoteLatestMessageId, source.data!.provider_email_id); assert.equal(context.remoteConversationId, source.data!.provider_thread_id)
  assert.ifError((await admin.from('outreach_fetch_queue').insert({ campaign_id: campaign.data!.id, client_id: f.a.client.id, provider_thread_id: source.data!.provider_thread_id!, completed_at: new Date().toISOString(), cursor: 'finished' })).error)
  const token = (claim.data as Claim).claimToken
  assert.equal((await admin.rpc('dispatch_outreach_reply', { p_command_id: (queued.data as Command).id, p_claim_token: token })).data, true)
  assert.equal((await admin.rpc('finish_outreach_reply', { p_command_id: (queued.data as Command).id, p_claim_token: token, p_status: 'sent', p_remote_message_id: 'accepted' })).data, true)
  const refresh = await admin.from('outreach_fetch_queue').select('completed_at,cursor').eq('campaign_id', campaign.data!.id).single(); assert.ifError(refresh.error)
  assert.deepEqual(refresh.data, { completed_at: null, cursor: null })
  assert.ifError((await admin.from('outreach_messages').delete().eq('id', source.data!.id)).error)
  assert.ifError((await admin.from('outreach_campaigns').update({ messages_purged_at: new Date().toISOString() }).eq('id', campaign.data!.id)).error)
  assert.deepEqual((await admin.from('outreach_reply_commands').select('id').eq('id', (queued.data as Command).id)).data, [])
  assert.deepEqual((await admin.from('outreach_conversations').select('id').eq('id', detail.id)).data, [])
})

test('one sender reserves only one pending thread and an abandoned queued command expires without dispatch', async (t) => {
  const f = await fixture(t)
  const other = await admin.from('outreach_conversations').insert({ client_id: f.a.client.id, channel: 'email', sender_id: f.sender.id, remote_conversation_id: randomUUID(), contact_address: 'other@example.test' }).select('id').single(); assert.ifError(other.error)
  assert.ifError((await admin.from('outreach_conversation_messages').insert({ client_id: f.a.client.id, conversation_id: other.data!.id, remote_message_id: randomUUID(), direction: 'received', body_text: 'Another prospect', sent_at: new Date().toISOString() })).error)
  const d = await f.a.supabase.rpc('read_outreach_conversation', { p_client_id: f.a.client.id, p_conversation_id: other.data!.id }); assert.ifError(d.error)
  const first = await f.enqueue(); assert.ifError(first.error)
  const detail = d.data as unknown as Detail
  assert.ok((await f.a.supabase.rpc('enqueue_outreach_reply', { p_client_id: f.a.client.id, p_conversation_id: detail.id, p_command_id: randomUUID(), p_expected_version: detail.version, p_latest_message_id: detail.latestMessageId, p_body: 'Other reply', p_takeover: true })).error)
  assert.ifError((await admin.from('outreach_reply_commands').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', (first.data as Command).id)).error)
  assert.equal((await admin.rpc('claim_outreach_reply', { p_command_id: (first.data as Command).id })).data, null)
  assert.equal((await f.detail()).commands[0].status, 'failed')
  assert.ifError((await f.enqueue()).error)
})


test('dispatch expiry uses wall time when its SQL transaction began before the deadline', async (t) => {
  const f = await fixture(t); const queued = await f.enqueue(); assert.ifError(queued.error)
  const id = (queued.data as Command).id
  const claimed = await admin.rpc('claim_outreach_reply', { p_command_id: id }); assert.ifError(claimed.error)
  const token = (claimed.data as Claim).claimToken
  const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([^"]+)"/m)?.[1]
  assert.match(project ?? '', /^[A-Za-z0-9_-]+$/)
  const container = execFileSync('docker', ['ps', '--filter', `label=com.supabase.cli.project=${project}`, '--filter', 'name=supabase_db_', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim()
  assert.ok(container && !container.includes('\n'))
  for (const value of [id, token]) assert.match(value, /^[a-f0-9-]{36}$/)
  const output = execFileSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq', '-c', `
    begin;
    update public.outreach_reply_commands set expires_at=clock_timestamp()+interval '500 milliseconds' where id='${id}';
    set local role service_role;
    select pg_sleep(0.6);
    select 'dispatch=' || public.dispatch_outreach_reply('${id}','${token}')::text;
    select 'status=' || status from public.outreach_reply_commands where id='${id}';
    rollback;
  `], { encoding: 'utf8' }).trim()
  assert.equal(output, 'dispatch=false\nstatus=failed')
})


for (const operation of ['enqueue', 'finish'] as const) {
test(`reply ${operation} and campaign retention acquire campaign before client without a deadlock`, async (t) => {
  const f = await fixture(t)
  const campaign = await admin.from('outreach_campaigns').insert({ client_id: f.a.client.id, provider_campaign_id: randomUUID(), name: 'Lock ordering' }).select('id').single(); assert.ifError(campaign.error)
  assert.ifError((await admin.from('outreach_messages').insert({ client_id: f.a.client.id, campaign_id: campaign.data!.id, provider_email_id: randomUUID(), provider_thread_id: randomUUID(), provider_account: f.sender.remote_sender_id, thread_key: randomUUID(), direction: 'received', lead_email: 'prospect@example.test', body_text: 'Question', sent_at: new Date().toISOString() })).error)
  const conversation = await admin.from('outreach_conversations').select('id').eq('campaign_id', campaign.data!.id).single(); assert.ifError(conversation.error)
  const result = await f.a.supabase.rpc('read_outreach_conversation', { p_client_id: f.a.client.id, p_conversation_id: conversation.data!.id }); assert.ifError(result.error); const detail = result.data as unknown as Detail
  const id = randomUUID(); let token = ''
  const enqueue = () => f.a.supabase.rpc('enqueue_outreach_reply', { p_client_id: f.a.client.id, p_conversation_id: detail.id, p_command_id: id, p_expected_version: detail.version, p_latest_message_id: detail.latestMessageId, p_body: 'Reply', p_takeover: true })
  if (operation === 'finish') {
    assert.ifError((await enqueue()).error)
    const claim = await admin.rpc('claim_outreach_reply', { p_command_id: id }); assert.ifError(claim.error); token = (claim.data as Claim).claimToken
    assert.equal((await admin.rpc('dispatch_outreach_reply', { p_command_id: id, p_claim_token: token })).data, true)
  }
  const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([^"]+)"/m)?.[1]; assert.match(project ?? '', /^[A-Za-z0-9_-]+$/)
  const container = execFileSync('docker', ['ps', '--filter', `label=com.supabase.cli.project=${project}`, '--filter', 'name=supabase_db_', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim()
  assert.ok(container && !container.includes('\n')); for (const value of [campaign.data!.id, f.a.client.id, detail.latestMessageId]) assert.match(value, /^[a-f0-9-]{36}$/)
  // Retention's campaign FOR UPDATE precedes mirror deletion/client locking.
  // The pause lets completion reach its lock request while this is held.
  const child = spawn('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq', '-c', `
    begin;
    set local deadlock_timeout='100ms';
    select id from public.outreach_campaigns where id='${campaign.data!.id}' for update;
    select id from public.outreach_conversation_messages where id='${detail.latestMessageId}' for update;
    do $$ begin raise notice 'campaign-locked'; end $$;
    select pg_sleep(0.5);
    select id from public.clients where id='${f.a.client.id}' for no key update;
    commit;
  `])
  let output = ''; let errors = ''
  const finished = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  const locked = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Retention lock marker was not received: ${errors}; ${output}`)), 5000)
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { errors += String(chunk); if (errors.includes('campaign-locked')) { clearTimeout(timer); resolve() } })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', () => { if (!errors.includes('campaign-locked')) { clearTimeout(timer); reject(new Error(`Retention process closed: ${errors}; ${output}`)) } })
  })
  t.after(() => { if (child.exitCode === null) child.kill() })
  await locked
  const complete = operation === 'enqueue' ? await enqueue() : await admin.rpc('finish_outreach_reply', { p_command_id: id, p_claim_token: token, p_status: 'sent', p_remote_message_id: 'accepted' })
  const code = await finished
  assert.ifError(complete.error); assert.ok(complete.data); assert.equal(code, 0, errors)
})
}

test('claim cannot revive a queued lease that expires while waiting for authority locks', async (t) => {
  const f = await fixture(t); const queued = await f.enqueue(); assert.ifError(queued.error); const id = (queued.data as Command).id
  const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([^"]+)"/m)?.[1]; assert.match(project ?? '', /^[A-Za-z0-9_-]+$/)
  const container = execFileSync('docker', ['ps', '--filter', `label=com.supabase.cli.project=${project}`, '--filter', 'name=supabase_db_', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim()
  assert.ok(container && !container.includes('\n')); for (const value of [f.a.client.id, f.a.user.id]) assert.match(value, /^[a-f0-9-]{36}$/)
  assert.ifError((await admin.from('outreach_reply_commands').update({ expires_at: new Date(Date.now() + 1000).toISOString() }).eq('id', id)).error)
  const child = spawn('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq', '-c', `
    begin;
    select user_id from public.outreach_memberships where client_id='${f.a.client.id}' and user_id='${f.a.user.id}' for update;
    do $$ begin raise notice 'authority-locked'; end $$;
    select pg_sleep(1.2);
    commit;
  `])
  let errors = ''
  const finished = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  const locked = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Authority lock marker was not received: ${errors}`)), 5000)
    child.stdout.resume()
    child.stderr.on('data', chunk => { errors += String(chunk); if (errors.includes('authority-locked')) { clearTimeout(timer); resolve() } })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', () => { if (!errors.includes('authority-locked')) { clearTimeout(timer); reject(new Error(errors)) } })
  })
  t.after(() => { if (child.exitCode === null) child.kill() })
  await locked
  const claim = await admin.rpc('claim_outreach_reply', { p_command_id: id })
  assert.equal(await finished, 0, errors); assert.ifError(claim.error); assert.equal(claim.data, null)
  assert.equal((await f.detail()).commands[0].status, 'failed')
})
