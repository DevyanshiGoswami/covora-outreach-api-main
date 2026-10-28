import { testProjectId, testDatabaseContainer } from '../helpers/stack.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { test, type TestContext } from 'node:test'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { createTenant } from '../helpers/tenants.ts'
import { grantOutreachMembership } from '../helpers/outreach.ts'

const admin = adminClient()
const remoteId = () => String(parseInt(randomUUID().replaceAll('-', '').slice(0, 12), 16) + 1)
function startSql(command: string) {
  const container = testDatabaseContainer
  assert.equal(execFileSync('docker', ['inspect', '--type', 'container', '--format', '{{index .Config.Labels "com.supabase.cli.project"}}', container], { encoding: 'utf8' }).trim(), testProjectId)
  const child = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { errors += String(chunk) })
  const done = new Promise<string>((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', code => { if (code === 0) resolve(output.trim()); else reject(new Error(errors || 'Isolated SQL failed')) })
  })
  child.stdin.write(command)
  return { child, done, output: () => output }
}
async function fixture(t: TestContext) {
  const a = await createTenant(t, { features: ['outreach_app'] })
  const b = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(a.user.id, a.client.id)
  await grantOutreachMembership(b.user.id, b.client.id)
  const campaign = await admin.from('outreach_campaigns').insert({ client_id: a.client.id, channel: 'linkedin', provider_campaign_id: remoteId(), name: 'Approved synthetic Covora campaign' }).select('*').single()
  const foreign = await admin.from('outreach_campaigns').insert({ client_id: b.client.id, channel: 'linkedin', provider_campaign_id: remoteId(), name: 'Unapproved business campaign' }).select('*').single()
  assert.ifError(campaign.error); assert.ifError(foreign.error)
  const workspace = await admin.from('outreach_reply_workspaces').insert({ client_id: a.client.id, channel: 'linkedin', remote_workspace_id: remoteId(), credential_ref: 'OUTREACH_HEYREACH_TEST_' + randomUUID().replaceAll('-', '').toUpperCase(), sync_enabled: true, enabled: true }).select('*').single()
  assert.ifError(workspace.error)
  const sender = await admin.from('outreach_reply_senders').insert({ client_id: a.client.id, channel: 'linkedin', workspace_id: workspace.data!.id, remote_sender_id: remoteId(), sender_address: 'https://www.linkedin.com/in/synthetic-sender', sender_label: 'Synthetic sender', enabled: true }).select('*').single()
  assert.ifError(sender.error)
  const input = {
    p_sender_id: sender.data!.id, p_campaign_id: campaign.data!.id, p_remote_campaign_id: campaign.data!.provider_campaign_id,
    p_sender_version: sender.data!.version, p_workspace_version: workspace.data!.version,
    p_remote_conversation_id: randomUUID(), p_contact_name: 'Synthetic prospect', p_contact_address: 'https://www.linkedin.com/in/synthetic-prospect', p_subject: '',
    p_messages: [{ fingerprint: randomUUID(), direction: 'received', bodyText: 'Synthetic inbound', sentAt: new Date().toISOString(), senderLabel: 'Synthetic prospect' }],
  }
  return { a, b, campaign: campaign.data!, foreign: foreign.data!, workspace: workspace.data!, sender: sender.data!, input }
}

test('business campaign channel defaults to email and identity cannot be repurposed', async (t) => {
  const a = await createTenant(t, { features: ['outreach_app'] })
  const email = await admin.from('outreach_campaigns').insert({ client_id: a.client.id, provider_campaign_id: randomUUID(), name: 'Email' }).select('*').single()
  assert.ifError(email.error); assert.equal(email.data!.channel, 'email')
  assert.ok((await admin.from('outreach_campaigns').update({ channel: 'linkedin' }).eq('id', email.data!.id)).error)
  for (const provider_campaign_id of ['0', '042', 'personal', '9007199254740992']) {
    assert.ok((await admin.from('outreach_campaigns').insert({ client_id: a.client.id, channel: 'linkedin', provider_campaign_id, name: 'Denied' })).error)
  }
})

test('LinkedIn assignments stay out of neutral email campaigns, statistics and leads', async (t) => {
  const f = await fixture(t)
  const email = await admin.from('outreach_campaigns').insert({ client_id: f.a.client.id, provider_campaign_id: randomUUID(), name: 'Visible email campaign' }).select('id').single()
  assert.ifError(email.error)
  for (const campaign_id of [email.data!.id, f.campaign.id]) {
    assert.ifError((await admin.from('outreach_campaign_steps').insert({ client_id: f.a.client.id, campaign_id, step: 0 })).error)
    assert.ifError((await admin.from('outreach_campaign_daily').insert({ client_id: f.a.client.id, campaign_id, day: '2026-10-05', sent: 1 })).error)
    assert.ifError((await admin.from('outreach_leads').insert({ client_id: f.a.client.id, campaign_id, email: randomUUID() + '@example.test' })).error)
  }
  assert.deepEqual((await f.a.supabase.from('client_outreach_campaigns').select('id')).data, [{ id: email.data!.id }])
  for (const table of ['client_outreach_campaign_steps', 'client_outreach_campaign_daily', 'client_outreach_leads'] as const) {
    const result = await f.a.supabase.from(table).select('campaign_id')
    assert.ifError(result.error); assert.deepEqual(result.data, [{ campaign_id: email.data!.id }])
  }
  assert.equal((await admin.from('outreach_sync_state').select('campaign_id').eq('campaign_id', f.campaign.id)).data?.length, 1)
})

test('import requires an approved same-tenant LinkedIn campaign and exact binding versions', async (t) => {
  const f = await fixture(t)
  for (const patch of [
    { p_campaign_id: f.foreign.id, p_remote_campaign_id: f.foreign.provider_campaign_id },
    { p_remote_campaign_id: remoteId() }, { p_campaign_id: randomUUID() },
    { p_sender_version: f.sender.version + 1 }, { p_workspace_version: f.workspace.version + 1 },
  ]) assert.equal((await admin.rpc('sync_outreach_linkedin_conversation', { ...f.input, ...patch })).error?.code, '42501')
  for (const session of [f.a.supabase, anonClient()]) assert.ok((await session.rpc('sync_outreach_linkedin_conversation', f.input)).error)
  const imported = await admin.rpc('sync_outreach_linkedin_conversation', f.input)
  assert.ifError(imported.error)
  const row = await admin.from('outreach_conversations').select('campaign_id').eq('id', imported.data!).single()
  assert.ifError(row.error); assert.equal(row.data!.campaign_id, f.campaign.id)
  assert.deepEqual((await f.b.supabase.rpc('list_outreach_conversations', { p_client_id: f.b.client.id })).data, [])
})

test('personal conversations and cross-business campaign relabeling are denied at the DB boundary', async (t) => {
  const f = await fixture(t)
  assert.equal((await admin.from('outreach_conversations').insert({ client_id: f.a.client.id, channel: 'linkedin', sender_id: f.sender.id, remote_conversation_id: randomUUID() })).error?.code, '42501')
  const imported = await admin.rpc('sync_outreach_linkedin_conversation', f.input); assert.ifError(imported.error)
  const other = await admin.from('outreach_campaigns').insert({ client_id: f.a.client.id, channel: 'linkedin', provider_campaign_id: remoteId(), name: 'Another explicitly assigned campaign' }).select('id,provider_campaign_id').single()
  assert.ifError(other.error)
  const sender = await admin.from('outreach_reply_senders').select('version').eq('id', f.sender.id).single()
  assert.equal((await admin.rpc('sync_outreach_linkedin_conversation', { ...f.input, p_sender_version: sender.data!.version, p_campaign_id: other.data!.id, p_remote_campaign_id: other.data!.provider_campaign_id })).error?.code, '42501')
  assert.equal((await admin.from('outreach_conversations').update({ campaign_id: other.data!.id }).eq('id', imported.data!)).error?.code, '42501')
})

test('assignment changes reset cursor and fence stale pages before importing', async (t) => {
  const f = await fixture(t)
  assert.ifError((await admin.from('outreach_reply_senders').update({ sync_cursor: 'previous-filter-cursor', synced_at: new Date().toISOString() }).eq('id', f.sender.id)).error)
  const added = await admin.from('outreach_campaigns').insert({ client_id: f.a.client.id, channel: 'linkedin', provider_campaign_id: remoteId(), name: 'Newly approved synthetic campaign' }).select('id').single()
  assert.ifError(added.error)
  const current = await admin.from('outreach_reply_senders').select('version,sync_cursor,synced_at').eq('id', f.sender.id).single()
  assert.ifError(current.error); assert.equal(current.data!.version, f.sender.version + 1); assert.equal(current.data!.sync_cursor, null); assert.equal(current.data!.synced_at, null)
  assert.equal((await admin.rpc('sync_outreach_linkedin_conversation', f.input)).error?.code, '42501')
  assert.ifError((await admin.rpc('sync_outreach_linkedin_conversation', { ...f.input, p_sender_version: current.data!.version })).error)
})

test('withdrawn LinkedIn campaign ownership cancels a prepared dispatch and removes its mirror', async (t) => {
  const f = await fixture(t)
  const imported = await admin.rpc('sync_outreach_linkedin_conversation', f.input); assert.ifError(imported.error)
  const read = await f.a.supabase.rpc('read_outreach_conversation', { p_client_id: f.a.client.id, p_conversation_id: imported.data! }); assert.ifError(read.error)
  const detail = read.data as { version: number; latestMessageId: string }
  const command = randomUUID()
  assert.ifError((await f.a.supabase.rpc('enqueue_outreach_reply', { p_client_id: f.a.client.id, p_conversation_id: imported.data!, p_command_id: command, p_expected_version: detail.version, p_latest_message_id: detail.latestMessageId, p_body: 'Synthetic human reply', p_takeover: true })).error)
  const claim = await admin.rpc('claim_outreach_reply', { p_command_id: command }); assert.ifError(claim.error)
  const prepared = claim.data as { claimToken: string; context: { remoteCampaignId: string } }
  assert.equal(prepared.context.remoteCampaignId, f.campaign.provider_campaign_id)
  assert.ifError((await admin.from('outreach_campaigns').delete().eq('id', f.campaign.id)).error)
  assert.equal((await admin.rpc('dispatch_outreach_reply', { p_command_id: command, p_claim_token: prepared.claimToken })).data, false)
  assert.deepEqual((await f.a.supabase.rpc('list_outreach_conversations', { p_client_id: f.a.client.id })).data, [])
  assert.ok((await f.a.supabase.rpc('read_outreach_conversation', { p_client_id: f.a.client.id, p_conversation_id: imported.data! })).error)
})

test('concurrent campaign withdrawal and dispatch serialize without a FK/client/sender deadlock', async (t) => {
  const f = await fixture(t)
  const imported = await admin.rpc('sync_outreach_linkedin_conversation', f.input); assert.ifError(imported.error)
  const read = await f.a.supabase.rpc('read_outreach_conversation', { p_client_id: f.a.client.id, p_conversation_id: imported.data! }); assert.ifError(read.error)
  const detail = read.data as { version: number; latestMessageId: string }
  const command = randomUUID()
  assert.ifError((await f.a.supabase.rpc('enqueue_outreach_reply', { p_client_id: f.a.client.id, p_conversation_id: imported.data!, p_command_id: command, p_expected_version: detail.version, p_latest_message_id: detail.latestMessageId, p_body: 'Synthetic human reply', p_takeover: true })).error)
  const claim = await admin.rpc('claim_outreach_reply', { p_command_id: command }); assert.ifError(claim.error)
  const token = (claim.data as { claimToken: string }).claimToken
  const dispatch = startSql(`begin; set local statement_timeout='5s'; select 1 from public.clients where id='${f.a.client.id}' for no key update; select 'CLIENT_LOCKED';\n`)
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Client lock was not observed')), 3000)
      dispatch.child.stdout.on('data', () => { if (dispatch.output().includes('CLIENT_LOCKED')) { clearTimeout(timer); resolve() } })
      if (dispatch.output().includes('CLIENT_LOCKED')) { clearTimeout(timer); resolve() }
    })
    const withdrawal = startSql(`begin; set local statement_timeout='5s'; delete from public.outreach_campaigns where id='${f.campaign.id}'; commit;\n`)
    withdrawal.child.stdin.end()
    // Establish that withdrawal has reached the before-cascade client fence.
    const deadline = Date.now() + 3000
    while (true) {
      const waiting = execFileSync('docker', ['exec', testDatabaseContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atq', '-c', `select count(*) from pg_stat_activity where wait_event_type='Lock' and query like 'delete from public.outreach_campaigns where id=%${f.campaign.id}%';`], { encoding: 'utf8' }).trim()
      if (waiting === '1') break
      assert.ok(Date.now() < deadline, 'withdrawal should wait for the client fence')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    dispatch.child.stdin.end(`set local role service_role; select public.dispatch_outreach_reply('${command}','${token}'); commit;\n`)
    const results = await Promise.all([dispatch.done, withdrawal.done])
    assert.ok(results[0].endsWith('t'), 'dispatch authorized before the serialized withdrawal commit')
    assert.equal((await admin.rpc('dispatch_outreach_reply', { p_command_id: command, p_claim_token: token })).data, false)
  } finally {
    dispatch.child.stdin.end()
    await dispatch.done.catch(() => {})
  }
})
