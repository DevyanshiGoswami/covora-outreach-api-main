import { testProjectId, testDatabaseContainer } from '../helpers/stack.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { setTimeout as pause } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { createAdmin, createTenant } from '../helpers/tenants.ts'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach.ts'

const admin = adminClient()
const credential = () => `OUTREACH_INSTANTLY_SHARED_${randomUUID().replaceAll('-', '').toUpperCase()}`
async function tenants(t: TestContext) {
  const a = await createTenant(t, { features: ['outreach_app'] })
  const b = await createTenant(t, { features: ['outreach_app'] })
  const owner = await createAdmin(t)
  await grantOutreachMembership(a.user.id, a.client.id)
  await grantOutreachMembership(b.user.id, b.client.id)
  await grantOutreachOwner(owner.user.id)
  return { a, b, owner, remote: randomUUID(), ref: credential() }
}
async function configure(f: Awaited<ReturnType<typeof tenants>>, clientId: string, remote = f.remote, ref = f.ref) {
  return f.owner.supabase.rpc('configure_outreach_account_workspace', {
    p_client_id: clientId, p_remote_workspace_id: remote, p_credential_ref: ref, p_enabled: true,
  })
}
async function binding(clientId: string, remote: string, ref: string, enabled = false) {
  return admin.from('outreach_reply_workspaces').insert({
    client_id: clientId, channel: 'email', remote_workspace_id: remote, credential_ref: ref, sync_enabled: true, enabled,
  }).select('*').single()
}
async function shared(t: TestContext) {
  const f = await tenants(t)
  const rows = []
  for (const [index, tenant] of [f.a, f.b].entries()) {
    assert.ifError((await configure(f, tenant.client.id)).error)
    const workspace = await binding(tenant.client.id, f.remote, f.ref, index === 0)
    assert.ifError(workspace.error)
    const email = `shared-${randomUUID()}@example.test`
    const account = await f.owner.supabase.rpc('register_outreach_account', {
      p_client_id: tenant.client.id, p_email: email, p_display_name: 'Synthetic sender',
    })
    assert.ifError(account.error)
    const sender = await admin.from('outreach_reply_senders').insert({
      client_id: tenant.client.id, channel: 'email', workspace_id: workspace.data!.id,
      remote_sender_id: email, sender_address: email, sender_label: 'Synthetic sender', enabled: index === 0,
    }).select('*').single()
    assert.ifError(sender.error)
    const campaign = await admin.from('outreach_campaigns').insert({
      client_id: tenant.client.id, provider_campaign_id: randomUUID(), name: `Synthetic tenant ${index}`,
    }).select('*').single()
    assert.ifError(campaign.error)
    const message = await admin.from('outreach_messages').insert({
      client_id: tenant.client.id, campaign_id: campaign.data!.id, provider_email_id: randomUUID(),
      provider_thread_id: randomUUID(), provider_account: email, thread_key: randomUUID(), direction: 'received',
      lead_email: 'prospect@example.test', from_email: 'prospect@example.test', to_email: email,
      subject: `Tenant ${index} only`, body_text: `Private history ${index}`, sent_at: new Date().toISOString(),
    }).select('*').single()
    assert.ifError(message.error)
    const conversation = await admin.from('outreach_conversations').select('id').eq('campaign_id', campaign.data!.id).single()
    assert.ifError(conversation.error)
    rows.push({ tenant, workspace: workspace.data!, sender: sender.data!, campaign: campaign.data!, message: message.data!, conversation: conversation.data!, account: account.data! })
  }
  return { ...f, rows }
}

test('shared email workspace preserves tenant-private accounts, campaigns and mirrored conversations', async t => {
  const f = await shared(t)
  for (const own of f.rows) {
    const foreign = f.rows.find(row => row !== own)!
    const session = own.tenant.supabase
    const accounts = await session.from('client_outreach_accounts').select('id,email')
    assert.ifError(accounts.error); assert.deepEqual(accounts.data, [{ id: own.account, email: own.sender.sender_address }])
    const campaigns = await session.from('client_outreach_campaigns').select('id')
    assert.ifError(campaigns.error); assert.deepEqual(campaigns.data, [{ id: own.campaign.id }])
    const conversations = await session.rpc('list_outreach_conversations', { p_client_id: own.tenant.client.id })
    assert.ifError(conversations.error)
    assert.deepEqual((conversations.data as { id: string }[]).map(row => row.id), [own.conversation.id])
    for (const hidden of [f.remote, f.ref, foreign.conversation.id, foreign.sender.sender_address]) {
      assert.equal(JSON.stringify(conversations.data).includes(hidden), false)
    }
    assert.equal((await session.rpc('read_outreach_conversation', {
      p_client_id: foreign.tenant.client.id, p_conversation_id: foreign.conversation.id,
    })).error?.code, '42501')
    assert.equal((await session.rpc('read_outreach_conversation', {
      p_client_id: own.tenant.client.id, p_conversation_id: foreign.conversation.id,
    })).error?.code, '42501')
    for (const table of ['outreach_account_workspaces', 'outreach_reply_workspaces', 'outreach_reply_senders'] as const) {
      assert.ok((await session.from(table).select('*')).error)
      assert.ok((await anonClient().from(table).select('*')).error)
    }
    assert.equal((await admin.from('outreach_campaigns').insert({
      client_id: own.tenant.client.id, provider_campaign_id: foreign.campaign.provider_campaign_id, name: 'Denied duplicate',
    })).error?.code, '23505')
    assert.ok((await admin.from('outreach_messages').insert({
      client_id: own.tenant.client.id, campaign_id: foreign.campaign.id, provider_email_id: randomUUID(),
      thread_key: randomUUID(), direction: 'received', sent_at: new Date().toISOString(),
    })).error)
    assert.ok((await admin.from('outreach_conversations').update({ sender_id: foreign.sender.id }).eq('id', own.conversation.id)).error)
    assert.equal((await f.owner.supabase.rpc('register_outreach_account', {
      p_client_id: own.tenant.client.id, p_email: foreign.sender.sender_address, p_display_name: '',
    })).error?.code, '22023')
    assert.ok((await admin.from('outreach_reply_senders').insert({
      client_id: own.tenant.client.id, channel: 'email', workspace_id: own.workspace.id,
      remote_sender_id: foreign.sender.sender_address, sender_address: foreign.sender.sender_address, sender_label: 'Denied sender',
    })).error)
  }
})

test('shared credential never inherits another tenant reply permission or dispatch identity', async t => {
  const f = await shared(t)
  const [live, readOnly] = f.rows
  const detail = async (row: typeof live) => {
    const result = await row.tenant.supabase.rpc('read_outreach_conversation', { p_client_id: row.tenant.client.id, p_conversation_id: row.conversation.id })
    assert.ifError(result.error)
    return result.data as { version: number; latestMessageId: string; canReply: boolean; messages: unknown[] }
  }
  const liveDetail = await detail(live), readDetail = await detail(readOnly)
  assert.equal(liveDetail.canReply, true); assert.equal(readDetail.canReply, false); assert.equal(readDetail.messages.length, 1)
  const input = (row: typeof live, d: typeof liveDetail) => ({
    p_client_id: row.tenant.client.id, p_conversation_id: row.conversation.id, p_command_id: randomUUID(),
    p_expected_version: d.version, p_latest_message_id: d.latestMessageId, p_body: 'Synthetic reply; no transport.', p_takeover: true,
  })
  assert.equal((await readOnly.tenant.supabase.rpc('enqueue_outreach_reply', input(readOnly, readDetail))).error?.code, '42501')
  assert.equal((await f.owner.supabase.rpc('enqueue_outreach_reply', input(readOnly, readDetail))).error?.code, '42501')
  assert.equal((await readOnly.tenant.supabase.rpc('enqueue_outreach_reply', input(live, liveDetail))).error?.code, '42501')
  const queued = await live.tenant.supabase.rpc('enqueue_outreach_reply', input(live, liveDetail))
  assert.ifError(queued.error)
  const command = queued.data as { id: string }
  const claim = await admin.rpc('claim_outreach_reply', { p_command_id: command.id })
  assert.ifError(claim.error)
  const prepared = claim.data as { claimToken: string; context: Record<string, string> }
  assert.equal(prepared.context.remoteWorkspaceId, f.remote)
  assert.equal(prepared.context.credentialRef, f.ref)
  assert.equal(prepared.context.senderAddress, live.sender.sender_address)
  assert.equal(prepared.context.remoteCampaignId, live.campaign.provider_campaign_id)
  // A separate tenant's sync toggle cannot disable the established tenant's command.
  assert.ifError((await admin.from('outreach_reply_workspaces').update({ sync_enabled: false }).eq('id', readOnly.workspace.id)).error)
  assert.equal((await admin.rpc('dispatch_outreach_reply', { p_command_id: command.id, p_claim_token: prepared.claimToken })).data, true)
  assert.deepEqual((await admin.from('outreach_reply_commands').select('id').eq('client_id', readOnly.tenant.client.id)).data, [])
})

test('email credentials must match one workspace across both registries; sole bindings can be reconfigured', async t => {
  const f = await tenants(t)
  assert.ifError((await configure(f, f.a.client.id)).error)
  const replacement = randomUUID()
  // The existing configuration UPSERT must still permit a sole binding remap.
  assert.ifError((await configure(f, f.a.client.id, replacement)).error)
  const reply = await binding(f.a.client.id, replacement, f.ref)
  assert.ifError(reply.error)
  assert.equal((await configure(f, f.a.client.id)).error?.code, '22023', 'same-client reply binding still prevents mismatch')
  assert.equal((await configure(f, f.b.client.id)).error?.code, '22023')
  assert.equal((await binding(f.b.client.id, f.remote, f.ref)).error?.code, '22023')
  assert.ifError((await configure(f, f.b.client.id, replacement)).error)
  const second = await binding(f.b.client.id, replacement, f.ref)
  assert.ifError(second.error)
  assert.equal((await admin.from('outreach_reply_workspaces').update({ remote_workspace_id: f.remote }).eq('id', second.data!.id)).error?.code, '22023')
  assert.equal((await admin.from('outreach_account_workspaces').update({ remote_workspace_id: f.remote }).eq('client_id', f.b.client.id)).error?.code, '22023')
  // Distinct email credentials may share the same provider workspace.
  assert.ifError((await admin.from('outreach_reply_workspaces').update({ credential_ref: credential() }).eq('id', second.data!.id)).error)

  const reverse = await tenants(t)
  const soleReply = await binding(reverse.a.client.id, reverse.remote, reverse.ref)
  assert.ifError(soleReply.error)
  assert.equal((await configure(reverse, reverse.b.client.id, randomUUID())).error?.code, '22023', 'reply-first registration is equally guarded')
  assert.ifError((await admin.from('outreach_reply_workspaces').update({ remote_workspace_id: replacement }).eq('id', soleReply.data!.id)).error)
  assert.ifError((await configure(reverse, reverse.b.client.id, replacement)).error)
})

test('LinkedIn workspace and credential uniqueness remain exclusive to one tenant', async t => {
  const f = await tenants(t)
  const row = { client_id: f.a.client.id, channel: 'linkedin', remote_workspace_id: f.remote, credential_ref: f.ref.replace('INSTANTLY', 'HEYREACH') }
  assert.ifError((await admin.from('outreach_reply_workspaces').insert(row)).error)
  assert.equal((await admin.from('outreach_reply_workspaces').insert({ ...row, client_id: f.b.client.id, credential_ref: row.credential_ref + '_B' })).error?.code, '23505')
  assert.equal((await admin.from('outreach_reply_workspaces').insert({ ...row, client_id: f.b.client.id, remote_workspace_id: randomUUID() })).error?.code, '23505')
  assert.ifError((await binding(f.b.client.id, f.remote, f.ref)).error)
})

function startSql(command: string) {
  const container = testDatabaseContainer
  assert.equal(execFileSync('docker', ['inspect', '--format', '{{index .Config.Labels "com.supabase.cli.project"}}', container], { encoding: 'utf8' }).trim(), testProjectId)
  const child = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-Atq'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stdout.on('data', value => { output += String(value) })
  child.stderr.on('data', value => { errors += String(value) })
  const done = new Promise<{ code: number | null; output: string; errors: string }>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => resolve({ code, output, errors }))
  })
  child.stdin.write(command)
  return { child, done, output: () => output }
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (!await predicate()) { assert.ok(Date.now() < deadline, 'isolated SQL rendezvous timed out'); await pause(20) }
}

test('concurrent cross-table credential mismatch waits, then fails under READ COMMITTED', async t => {
  const f = await tenants(t)
  const first = startSql(`begin; insert into public.outreach_account_workspaces(client_id,remote_workspace_id,credential_ref) values('${f.a.client.id}','${f.remote}','${f.ref}'); select 'holding';\n`)
  let second: ReturnType<typeof startSql> | undefined
  try {
    await until(() => first.output().includes('holding'))
    const app = `credential_${randomUUID()}`
    second = startSql(`set application_name='${app}'; begin; insert into public.outreach_reply_workspaces(client_id,channel,remote_workspace_id,credential_ref) values('${f.b.client.id}','email','${randomUUID()}','${f.ref}'); commit;\n`)
    second.child.stdin.end()
    await until(async () => {
      const observer = startSql(`select count(*) from pg_stat_activity where application_name='${app}' and wait_event_type='Lock';\n`)
      observer.child.stdin.end()
      return (await observer.done).output.trim() === '1'
    })
    first.child.stdin.end('commit;\n')
    assert.equal((await first.done).code, 0)
    const result = await second.done
    assert.notEqual(result.code, 0); assert.match(result.errors, /22023/)
    assert.deepEqual((await admin.from('outreach_reply_workspaces').select('id').eq('client_id', f.b.client.id)).data, [])
  } finally {
    // Release held FK/credential locks before tenant cleanup, including failures.
    if (!first.child.stdin.writableEnded) first.child.stdin.end('rollback;\n')
    await first.done
    if (second) await second.done
  }
})

test('an existing credential guard rejects stale REPEATABLE READ configuration', async t => {
  const f = await tenants(t)
  assert.ifError((await configure(f, f.a.client.id)).error)
  assert.ifError((await admin.from('outreach_account_workspaces').delete().eq('client_id', f.a.client.id)).error)
  const stale = startSql(`begin isolation level repeatable read; select count(*) from outreach_private.email_credential_guards where credential_ref='${f.ref}'; select 'snapshot';\n`)
  try {
    await until(() => stale.output().includes('snapshot'))
    assert.ifError((await binding(f.a.client.id, f.remote, f.ref)).error)
    stale.child.stdin.end(`insert into public.outreach_account_workspaces(client_id,remote_workspace_id,credential_ref) values('${f.b.client.id}','${randomUUID()}','${f.ref}'); commit;\n`)
    const result = await stale.done
    assert.notEqual(result.code, 0); assert.match(result.errors, /40001/)
    assert.deepEqual((await admin.from('outreach_account_workspaces').select('client_id').eq('client_id', f.b.client.id)).data, [])
  } finally {
    if (!stale.child.stdin.writableEnded) stale.child.stdin.end('rollback;\n')
    await stale.done
  }
})
