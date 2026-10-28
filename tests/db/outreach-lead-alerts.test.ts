import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { test, type TestContext } from 'node:test'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { loadTestEnv } from '../helpers/env.ts'
import { createTenant, createUser, type Session } from '../helpers/tenants.ts'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach.ts'
import { runOutreachLeadAlerts, type LeadAlertDispatch } from '../../src/lib/outreach-lead-alert-worker.ts'
import { renderLeadAlertEmail } from '../../src/lib/outreach-lead-alert-email.ts'

const admin = adminClient()
type Alert = { id: string; claimToken: string; clientId: string; userId: string; recipientEmail: string; leadCount: number; expiresAt: string }
type Policy = { clientId: string; userId: string; enabled: boolean; threshold: number; cooldownHours: number; enabledAt: string | null; version: number }

async function fixture(t: TestContext) {
  const a = await createTenant(null, { features: ['outreach_app'] })
  const b = await createTenant(null, { features: ['outreach_app'] })
  const people: Awaited<ReturnType<typeof createUser>>[] = []
  t.after(async () => { await a.cleanup(); await b.cleanup(); for (const p of people) assert.ifError((await admin.auth.admin.deleteUser(p.user.id)).error) })
  await grantOutreachMembership(a.user.id, a.client.id, 'client_admin')
  await grantOutreachMembership(b.user.id, b.client.id, 'client_member')
  const owner = await createUser({ clientId: null }); people.push(owner); await grantOutreachOwner(owner.user.id)
  async function person(role: 'client_admin' | 'client_member' | 'client_viewer' | 'operator' = 'client_member') {
    const p = await createUser({ clientId: null }); people.push(p); await grantOutreachMembership(p.user.id, a.client.id, role); return p
  }
  async function configure(enabled = true, threshold = 5, userId = a.user.id, session: Session = owner.session) {
    return session.rpc('configure_outreach_lead_alert', { p_client_id: a.client.id, p_user_id: userId, p_enabled: enabled, p_threshold: threshold, p_cooldown_hours: 24 })
  }
  const campaign = await admin.from('outreach_campaigns').insert({ client_id: a.client.id, provider_campaign_id: randomUUID(), name: 'Alert fixture' }).select('*').single()
  assert.ifError(campaign.error)
  async function lead(email = `${randomUUID()}@example.test`, overrides: Record<string, unknown> = {}) {
    const row = await admin.from('outreach_messages').insert({ client_id: a.client.id, campaign_id: campaign.data!.id,
      provider_email_id: randomUUID(), provider_thread_id: randomUUID(), provider_account: 'sender@example.test', thread_key: randomUUID(),
      direction: 'received', from_email: email, to_email: 'sender@example.test', lead_email: email, body_text: 'Interested',
      // Host and local container clocks can differ by a few milliseconds.
      interest: 'Interested', sent_at: new Date(Date.now() + 1000).toISOString(), ...overrides }).select('*').single()
    assert.ifError(row.error)
    const conversation = await admin.from('outreach_conversations').select('*').eq('campaign_id', row.data!.campaign_id).eq('source_thread_key', row.data!.thread_key).single()
    assert.ifError(conversation.error)
    return { source: row.data!, conversation: conversation.data! }
  }
  async function leads(count = 5) { const rows = []; for (let i = 0; i < count; i++) rows.push(await lead()); return rows }
  async function claim(userId = a.user.id) {
    const result = await admin.rpc('claim_outreach_lead_alert', { p_client_id: a.client.id, p_user_id: userId })
    assert.ifError(result.error); return result.data as Alert | null
  }
  async function dispatch(alert: Alert) {
    const result = await admin.rpc('dispatch_outreach_lead_alert', { p_delivery_id: alert.id, p_claim_token: alert.claimToken })
    assert.ifError(result.error); return result.data as Alert | null
  }
  async function finish(alert: Alert, status: 'sent' | 'failed' | 'unknown') {
    const result = await admin.rpc('finish_outreach_lead_alert', { p_delivery_id: alert.id, p_claim_token: alert.claimToken, p_status: status })
    assert.ifError(result.error); return result.data
  }
  return { a, b, owner, person, configure, campaign: campaign.data!, lead, leads, claim, dispatch, finish }
}

test('alert policies are disabled by default, bounded, private, and only the active agency owner may configure them', async (t) => {
  const f = await fixture(t)
  const inserted = await admin.from('outreach_lead_alert_policies').insert({ client_id: f.a.client.id, user_id: f.a.user.id }).select('*').single()
  assert.ifError(inserted.error); assert.equal(inserted.data!.enabled, false); assert.equal(inserted.data!.enabled_at, null)
  for (const threshold of [0, 101]) assert.ok((await f.configure(true, threshold)).error)
  for (const session of [f.a.supabase, f.b.supabase, anonClient(), admin]) {
    assert.ok((await f.configure(true, 5, f.a.user.id, session)).error)
  }
  assert.ok((await f.configure(true, 5, f.b.user.id)).error, 'cross-tenant recipient is not a member')
  for (const role of ['client_viewer', 'operator'] as const) {
    const recipient = await f.person(role)
    assert.ok((await f.configure(true, 5, recipient.user.id)).error, 'recipient must be able to act on client leads')
  }
  const enabled = await f.configure(); assert.ifError(enabled.error)
  assert.equal((enabled.data as Policy).threshold, 5); assert.ok((enabled.data as Policy).enabledAt)
  for (const session of [f.a.supabase, f.b.supabase, anonClient()]) {
    for (const table of ['outreach_lead_alert_policies', 'outreach_lead_alert_deliveries', 'outreach_lead_alert_items'] as const) {
      assert.ok((await session.from(table).select('*')).error)
      assert.ok((await session.from(table).insert({} as never)).error)
    }
    assert.ok((await session.rpc('claim_outreach_lead_alert', { p_client_id: f.a.client.id, p_user_id: f.a.user.id })).error)
    assert.ok((await session.rpc('dispatch_outreach_lead_alert', { p_delivery_id: randomUUID(), p_claim_token: randomUUID() })).error)
    assert.ok((await session.rpc('finish_outreach_lead_alert', { p_delivery_id: randomUUID(), p_claim_token: randomUUID(), p_status: 'sent' })).error)
    assert.ok((await session.rpc('reserve_outreach_lead_alert_policies', { p_limit: 50 })).error)
    assert.ok((await session.rpc('outreach_lead_alert_delivery_health')).error)
  }
})

test('policy reservations rotate fairly without changing the consent version', async (t) => {
  const f = await fixture(t); const member = await f.person()
  assert.ifError((await f.configure(true, 1)).error)
  assert.ifError((await f.configure(true, 1, member.user.id)).error)
  const before = await admin.from('outreach_lead_alert_policies').select('*').eq('client_id', f.a.client.id).order('user_id')
  assert.ifError(before.error)
  const first = await admin.rpc('reserve_outreach_lead_alert_policies', { p_limit: 1 }); assert.ifError(first.error)
  const second = await admin.rpc('reserve_outreach_lead_alert_policies', { p_limit: 1 }); assert.ifError(second.error)
  const firstRows = first.data as { clientId: string; userId: string }[]
  const secondRows = second.data as { clientId: string; userId: string }[]
  assert.equal(firstRows.length, 1); assert.equal(secondRows.length, 1)
  assert.equal(firstRows[0].clientId, f.a.client.id); assert.equal(secondRows[0].clientId, f.a.client.id)
  assert.notEqual(firstRows[0].userId, secondRows[0].userId)
  const third = await admin.rpc('reserve_outreach_lead_alert_policies', { p_limit: 50 }); assert.ifError(third.error)
  assert.deepEqual(third.data, [])
  const after = await admin.from('outreach_lead_alert_policies').select('*').eq('client_id', f.a.client.id).order('user_id')
  assert.ifError(after.error)
  assert.deepEqual(after.data!.map(({ last_scanned_at: scan, ...row }) => { assert.ok(scan); return row }),
    before.data!.map(({ last_scanned_at: scan, ...row }) => { assert.equal(scan, null); return row }))
  for (const limit of [0, 1001]) assert.ok((await admin.rpc('reserve_outreach_lead_alert_policies', { p_limit: limit })).error)
})

test('only five distinct new human Interested leads qualify; automatic, negative, old, read and replied threads do not', async (t) => {
  const f = await fixture(t)
  await f.lead('historic@example.test', { sent_at: '2020-01-01T00:00:00.000Z' })
  assert.ifError((await f.configure()).error)
  await f.lead(undefined, { is_auto_reply: true })
  await f.lead(undefined, { interest: 'Not interested' })
  await f.lead(undefined, { interest: 'Meeting booked' })
  await f.lead(undefined, { direction: 'sent' })
  const read = await f.lead(); assert.ifError((await f.a.supabase.rpc('mark_outreach_conversation_read', { p_client_id: f.a.client.id, p_conversation_id: read.conversation.id })).error)
  const suppressed = await f.lead(); assert.ifError((await admin.from('outreach_conversations').update({ suppressed: true }).eq('id', suppressed.conversation.id)).error)
  const waiting = await f.lead(); assert.ifError((await admin.from('outreach_conversations').update({ status: 'waiting' }).eq('id', waiting.conversation.id)).error)
  const duplicate = await f.lead('same@example.test'); await f.lead(' SAME@example.test ')
  await f.leads(3)
  assert.equal(await f.claim(), null, 'duplicate contact counts only once')
  await f.lead()
  const alert = await f.claim(); assert.ok(alert); assert.equal(alert.leadCount, 5)
  assert.equal(alert.recipientEmail, f.a.user.email); assert.ok(Date.parse(alert.expiresAt) > Date.now())
  assert.doesNotMatch(JSON.stringify(alert), new RegExp(duplicate.source.provider_email_id))
})

test('the latest event across duplicate contacts is evaluated before interest and suppression filters', async (t) => {
  const f = await fixture(t); assert.ifError((await f.configure(true, 1)).error)
  await f.lead('duplicate@example.test')
  await f.lead('DUPLICATE@example.test', { interest: 'Not interested' })
  assert.equal(await f.claim(), null, 'new negative thread must suppress an older interested thread')
  await f.lead('duplicate@example.test')
  assert.ok(await f.claim())
})

test('competing claims and dispatches produce one delivery and one dispatch authorization', async (t) => {
  const f = await fixture(t); assert.ifError((await f.configure()).error); await f.leads()
  const claims = await Promise.all(Array.from({ length: 8 }, () => f.claim()))
  const accepted = claims.filter((claim): claim is Alert => claim !== null)
  assert.equal(accepted.length, 1)
  const dispatched = await Promise.all(Array.from({ length: 8 }, () => f.dispatch(accepted[0])))
  assert.equal(dispatched.filter(Boolean).length, 1)
  assert.equal(await f.finish(accepted[0], 'sent'), true)
  assert.equal(await f.finish(accepted[0], 'sent'), true, 'completion is idempotent')
  assert.equal(await f.claim(), null)
})

test('dispatch revalidates read state and cancels a batch that falls below its threshold', async (t) => {
  const f = await fixture(t); assert.ifError((await f.configure()).error); const leads = await f.leads()
  const alert = await f.claim(); assert.ok(alert)
  assert.ifError((await f.a.supabase.rpc('mark_outreach_conversation_read', { p_client_id: f.a.client.id, p_conversation_id: leads[0].conversation.id })).error)
  assert.equal(await f.dispatch(alert), null)
  assert.equal((await admin.from('outreach_lead_alert_deliveries').select('status').eq('id', alert.id).single()).data!.status, 'cancelled')
  assert.equal((await admin.from('outreach_lead_alert_items').select('*').eq('delivery_id', alert.id)).data!.length, 0)
})

for (const change of ['revoked', 'suspended', 'feature_off', 'policy_off', 'recipient_email', 'unconfirmed'] as const) {
  test(`dispatch rejects changed authorization: ${change}`, async (t) => {
    const f = await fixture(t); assert.ifError((await f.configure(true, 1)).error); await f.lead(); const alert = await f.claim(); assert.ok(alert)
    if (change === 'revoked' || change === 'suspended') assert.ifError((await admin.from('outreach_memberships').update({ state: change }).eq('client_id', f.a.client.id).eq('user_id', f.a.user.id)).error)
    if (change === 'feature_off') assert.ifError((await admin.from('client_features').update({ enabled: false }).eq('client_id', f.a.client.id).eq('feature', 'outreach_app')).error)
    if (change === 'policy_off') assert.ifError((await f.configure(false, 1)).error)
    if (change === 'recipient_email') assert.ifError((await admin.auth.admin.updateUserById(f.a.user.id, { email: `${randomUUID()}@test.local`, email_confirm: true })).error)
    if (change === 'unconfirmed') assert.ifError((await admin.auth.admin.updateUserById(f.a.user.id, { email: `${randomUUID()}@test.local`, email_confirm: false })).error)
    assert.equal(await f.dispatch(alert), null)
  })
}

test('read state belongs to the recipient and multiple explicit client recipients are independent', async (t) => {
  const f = await fixture(t); const member = await f.person(); assert.ifError((await f.configure(true, 1)).error)
  assert.ifError((await f.configure(true, 1, member.user.id)).error)
  const lead = await f.lead()
  assert.ifError((await f.a.supabase.rpc('mark_outreach_conversation_read', { p_client_id: f.a.client.id, p_conversation_id: lead.conversation.id })).error)
  assert.equal(await f.claim(), null)
  const other = await f.claim(member.user.id); assert.ok(other); assert.equal(other.recipientEmail, member.user.email)
})

test('a delayed newly ingested message is unread even when its send time predates the recipient read', async (t) => {
  const f = await fixture(t); const configured = await f.configure(true, 1); assert.ifError(configured.error)
  const sentAt = new Date(Date.parse((configured.data as Policy).enabledAt!) + 1).toISOString()
  const first = await f.lead('delayed@example.test', { sent_at: sentAt })
  assert.ifError((await f.a.supabase.rpc('mark_outreach_conversation_read', { p_client_id: f.a.client.id, p_conversation_id: first.conversation.id })).error)
  assert.equal(await f.claim(), null)
  await f.lead('delayed@example.test', { thread_key: first.source.thread_key, provider_thread_id: first.source.provider_thread_id,
    sent_at: new Date(Date.parse(first.source.sent_at) + 1).toISOString() })
  assert.ok(await f.claim())
})

test('unconfirmed client Auth identities cannot be enabled as recipients', async (t) => {
  const f = await fixture(t)
  const created = await admin.auth.admin.createUser({ email: `pending-${randomUUID()}@test.local`, password: randomUUID(), email_confirm: false })
  assert.ifError(created.error); const user = created.data.user!
  t.after(async () => { assert.ifError((await admin.auth.admin.deleteUser(user.id)).error) })
  await grantOutreachMembership(user.id, f.a.client.id, 'client_member')
  assert.ok((await f.configure(true, 1, user.id)).error)
})

test('source state and policy changes cancel stale claims and re-enable does not send historical backlog', async (t) => {
  const f = await fixture(t); assert.ifError((await f.configure(true, 1)).error); const lead = await f.lead()
  const alert = await f.claim(); assert.ok(alert)
  assert.ifError((await admin.from('outreach_messages').update({ interest: 'Not interested' }).eq('id', lead.source.id)).error)
  assert.equal(await f.dispatch(alert), null)
  assert.ifError((await f.configure(false, 1)).error)
  await f.lead('while-disabled@example.test', { sent_at: '2020-01-01T00:00:00.000Z' })
  assert.ifError((await f.configure(true, 1)).error)
  assert.equal(await f.claim(), null)
  await f.lead('fresh-after-enable@example.test'); assert.ok(await f.claim())
})

test('successful receipts deduplicate the lead across campaigns and cooldown applies only to newly distinct leads', async (t) => {
  const f = await fixture(t); assert.ifError((await f.configure(true, 1)).error); await f.lead('one@example.test')
  const alert = await f.claim(); assert.ok(alert); assert.ok(await f.dispatch(alert)); assert.equal(await f.finish(alert, 'sent'), true)
  const nextCampaign = await admin.from('outreach_campaigns').insert({ client_id: f.a.client.id, provider_campaign_id: randomUUID(), name: 'Another campaign' }).select('id').single()
  assert.ifError(nextCampaign.error)
  await f.lead('ONE@example.test', { campaign_id: nextCampaign.data!.id })
  assert.ifError((await admin.from('outreach_lead_alert_deliveries').update({ finished_at: new Date(Date.now() - 25 * 3600_000).toISOString() }).eq('id', alert.id)).error)
  assert.equal(await f.claim(), null, 'a newer thread is still the same previously alerted lead')
  await f.lead('two@example.test'); const second = await f.claim(); assert.ok(second)
  assert.ok(await f.dispatch(second)); assert.equal(await f.finish(second, 'sent'), true)
  await f.lead('three@example.test'); assert.equal(await f.claim(), null, 'new lead waits for recipient cooldown')
})

test('expired preparation can be reclaimed; dispatched expiry and unknown outcomes never auto-retry', async (t) => {
  const f = await fixture(t); assert.ifError((await f.configure(true, 1)).error); await f.lead()
  const first = await f.claim(); assert.ok(first)
  assert.ifError((await admin.from('outreach_lead_alert_deliveries').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', first.id)).error)
  const replacement = await f.claim(); assert.ok(replacement); assert.notEqual(replacement.claimToken, first.claimToken)
  assert.equal(await f.dispatch(first), null)
  assert.ok(await f.dispatch(replacement))
  assert.ifError((await admin.from('outreach_lead_alert_deliveries').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', replacement.id)).error)
  assert.equal(await f.claim(), null)
  assert.equal((await admin.from('outreach_lead_alert_deliveries').select('status').eq('id', replacement.id).single()).data!.status, 'unknown')
  await f.leads(6); assert.equal(await f.claim(), null, 'uncertain delivery blocks new batches for this recipient')
  assert.equal(await f.finish(replacement, 'failed'), false, 'unknown cannot be converted into an automatic retry')
  assert.equal(await f.finish(replacement, 'sent'), true, 'a late confirmed success may settle an unknown outcome')
})

test('an explicit unknown result remains blocked across policy disable/re-enable', async (t) => {
  const f = await fixture(t); assert.ifError((await f.configure(true, 1)).error); await f.lead()
  const alert = await f.claim(); assert.ok(alert); assert.ok(await f.dispatch(alert)); assert.equal(await f.finish(alert, 'unknown'), true)
  assert.ifError((await f.configure(false, 1)).error); assert.ifError((await f.configure(true, 1)).error); await f.lead()
  assert.equal(await f.claim(), null)
})

test('confirmed failures stay terminal until explicit owner reconfiguration, even if settings are unchanged', async (t) => {
  const f = await fixture(t); const configured = await f.configure(true, 1); assert.ifError(configured.error); await f.lead()
  const alert = await f.claim(); assert.ok(alert); assert.ok(await f.dispatch(alert)); assert.equal(await f.finish(alert, 'failed'), true)
  assert.equal(await f.claim(), null)
  const retried = await f.configure(true, 1); assert.ifError(retried.error)
  assert.ok((retried.data as Policy).version > (configured.data as Policy).version)
  assert.ok(await f.claim())
})

for (const status of ['queued', 'preparing', 'sending', 'sent', 'unknown'] as const) {
  test(`an existing ${status} reply command against the latest message excludes a lead`, async (t) => {
    const f = await fixture(t); assert.ifError((await f.configure(true, 1)).error)
    const workspace = await admin.from('outreach_reply_workspaces').insert({ client_id: f.a.client.id, channel: 'email',
      remote_workspace_id: randomUUID(), credential_ref: `OUTREACH_INSTANTLY_ALERT_${randomUUID().replaceAll('-', '').toUpperCase()}` }).select('*').single()
    assert.ifError(workspace.error)
    const address = `${randomUUID()}@example.test`
    const sender = await admin.from('outreach_reply_senders').insert({ client_id: f.a.client.id, channel: 'email',
      workspace_id: workspace.data!.id, remote_sender_id: address, sender_address: address, sender_label: 'Sender' }).select('*').single()
    assert.ifError(sender.error)
    const lead = await f.lead(undefined, { provider_account: address })
    assert.ifError((await admin.from('outreach_reply_commands').insert({ id: randomUUID(), client_id: f.a.client.id,
      conversation_id: lead.conversation.id, channel: 'email', sender_id: sender.data!.id, actor_user_id: f.a.user.id,
      authority_stamp: 'client_admin:1', conversation_version: lead.conversation.version, latest_message_id: lead.conversation.latest_message_id!,
      workspace_version: workspace.data!.version, sender_version: sender.data!.version, body_text: 'Already handled', status })).error)
    assert.equal(await f.claim(), null)
  })
}

test('real worker DB flow sends one qualifying batch through a fake transport and records durable sent state', async (t) => {
  const f = await fixture(t); assert.ifError((await f.configure()).error); await f.leads()
  const previous = process.env.ENABLE_OUTREACH_LEAD_ALERT_EMAILS
  process.env.ENABLE_OUTREACH_LEAD_ALERT_EMAILS = 'true'
  t.after(() => { if (previous === undefined) delete process.env.ENABLE_OUTREACH_LEAD_ALERT_EMAILS; else process.env.ENABLE_OUTREACH_LEAD_ALERT_EMAILS = previous })
  const sent: LeadAlertDispatch[] = []
  const transport = { configured: true, send: async (payload: LeadAlertDispatch) => {
    sent.push(payload)
    const rendered = renderLeadAlertEmail({ leadCount: payload.leadCount, clientId: payload.clientId, portalOrigin: 'https://covora.app' })
    assert.ok(rendered.subject && rendered.text)
    return { status: 'sent' as const }
  } }
  const context = { deadline: Date.now() + 45_000, timeLeft: () => 45_000 }
  assert.equal((await runOutreachLeadAlerts(context, transport)).sent, 1)
  assert.equal(sent.length, 1); assert.equal(sent[0].recipientEmail, f.a.user.email); assert.equal(sent[0].leadCount, 5)
  assert.equal((await runOutreachLeadAlerts(context, transport)).sent, 0); assert.equal(sent.length, 1)
  const row = await admin.from('outreach_lead_alert_deliveries').select('status').eq('id', sent[0].id).single()
  assert.ifError(row.error); assert.equal(row.data!.status, 'sent')
})

test('pre-dispatch authorization uses wall time after a lock wait, not transaction start', async (t) => {
  // Identify the DB by the explicitly configured local API port, never by a
  // repository config that could belong to another running pilot stack.
  const api = new URL(loadTestEnv().URL)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname) && api.port)
  const gateways = execFileSync('docker', ['ps', '--filter', 'name=supabase_kong_', '--format', '{{.ID}}'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  assert.ok(gateways.length)
  const bindings = execFileSync('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}|{{index .Config.Labels "com.supabase.cli.project"}}', ...gateways], { encoding: 'utf8' }).trim().split('\n')
  const projects = bindings.flatMap((binding) => {
    const [portsJson, name] = binding.split('|')
    const ports = JSON.parse(portsJson) as Record<string, { HostPort: string }[] | null>
    return ports['8000/tcp']?.some((port) => port.HostPort === api.port) ? [name] : []
  })
  assert.equal(projects.length, 1, 'The configured API port must identify exactly one local stack')
  const project = projects[0]
  assert.match(project, /^[A-Za-z0-9_-]+$/)
  if (process.env.OUTREACH_ALERT_TEST_PROJECT) assert.equal(project, process.env.OUTREACH_ALERT_TEST_PROJECT)
  const container = execFileSync('docker', ['ps', '--filter', `label=com.supabase.cli.project=${project}`, '--filter', 'name=supabase_db_', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim()
  assert.ok(container && !container.includes('\n'))
  const f = await fixture(t); assert.ifError((await f.configure(true, 1)).error); await f.lead(); const alert = await f.claim(); assert.ok(alert)
  const output = execFileSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq', '-c', `
    begin;
    update public.outreach_lead_alert_deliveries set expires_at=clock_timestamp()+interval '300 milliseconds' where id='${alert.id}';
    set local role service_role;
    select pg_sleep(0.4);
    select coalesce(public.dispatch_outreach_lead_alert('${alert.id}','${alert.claimToken}')::text,'null');
    rollback;
  `], { encoding: 'utf8' }).trim()
  assert.equal(output, 'null')
})
