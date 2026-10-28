import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import { adminClient } from '../helpers/admin.ts'
import { createTenant } from '../helpers/tenants.ts'
import { grantOutreachMembership } from '../helpers/outreach.ts'

type Summary = { id: string; latestAt: string; preview: string }
type Message = { direction: 'sent' | 'received'; bodyText: string }
const admin = adminClient()

async function fixture(t: TestContext, channel: 'email' | 'linkedin' = 'email') {
  const tenant = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(tenant.user.id, tenant.client.id)
  const campaign = channel === 'linkedin' ? await admin.from('outreach_campaigns').insert({
    client_id: tenant.client.id, channel, name: 'Synthetic approved LinkedIn campaign',
    provider_campaign_id: String(parseInt(randomUUID().replaceAll('-', '').slice(0, 12), 16) + 1),
  }).select('id').single() : null
  if (campaign) assert.ifError(campaign.error)
  const workspace = await admin.from('outreach_reply_workspaces').insert({
    client_id: tenant.client.id, channel, remote_workspace_id: randomUUID(),
    credential_ref: `OUTREACH_${channel === 'email' ? 'INSTANTLY' : 'HEYREACH'}_TEST_${randomUUID().replaceAll('-', '').toUpperCase()}`,
  }).select('id').single()
  assert.ifError(workspace.error)
  const address = channel === 'email' ? `sender-${randomUUID()}@example.test` : 'https://www.linkedin.com/in/synthetic-sender'
  const sender = await admin.from('outreach_reply_senders').insert({
    client_id: tenant.client.id, channel, workspace_id: workspace.data!.id,
    remote_sender_id: channel === 'email' ? address : randomUUID(), sender_address: address, sender_label: 'Synthetic sender',
  }).select('id').single()
  assert.ifError(sender.error)

  async function conversation(messages: (Message & { sentAt: string })[]) {
    const row = await admin.from('outreach_conversations').insert({
      client_id: tenant.client.id, channel, campaign_id: campaign?.data?.id ?? null,
      sender_id: sender.data!.id, remote_conversation_id: randomUUID(),
      contact_address: 'prospect@example.test', subject: 'Synthetic conversation',
    }).select('id').single()
    assert.ifError(row.error)
    for (const message of messages) {
      assert.ifError((await admin.from('outreach_conversation_messages').insert({
        client_id: tenant.client.id, conversation_id: row.data!.id, remote_message_id: randomUUID(),
        direction: message.direction, body_text: message.bodyText, sent_at: message.sentAt, sender_label: 'Synthetic participant',
      })).error)
    }
    return row.data!.id
  }
  async function list(p_channel: 'all' | 'email' | 'linkedin' = 'all', p_limit = 51, before?: Summary) {
    const result = await tenant.supabase.rpc('list_outreach_conversations', {
      p_client_id: tenant.client.id, p_channel, p_limit,
      ...(before ? { p_before_at: before.latestAt, p_before_id: before.id } : {}),
    })
    assert.ifError(result.error)
    return result.data as unknown as Summary[]
  }
  return { tenant, conversation, list }
}

test('reply inbox hides sent-only email threads in all/email while LinkedIn stays unchanged', async t => {
  const email = await fixture(t)
  const coldId = await email.conversation([{ direction: 'sent', bodyText: 'Cold outreach', sentAt: '2026-10-05T12:00:00Z' }])
  const foreign = await fixture(t)
  await foreign.conversation([{ direction: 'received', bodyText: 'Other tenant reply', sentAt: '2026-10-05T12:00:00Z' }])
  assert.deepEqual(await email.list('all'), [])
  assert.deepEqual(await email.list('email'), [])
  const replyId = await email.conversation([{ direction: 'received', bodyText: 'Different thread reply', sentAt: '2026-10-05T12:00:00Z' }])
  assert.deepEqual((await email.list('all')).map(row => row.id), [replyId])
  assert.deepEqual((await email.list('email')).map(row => row.id), [replyId])
  const detail = await email.tenant.supabase.rpc('read_outreach_conversation', { p_client_id: email.tenant.client.id, p_conversation_id: coldId })
  assert.ifError(detail.error)
  assert.equal((detail.data as unknown as { messages: Message[] }).messages[0].bodyText, 'Cold outreach')
  const linkedin = await fixture(t, 'linkedin')
  const id = await linkedin.conversation([{ direction: 'sent', bodyText: 'Approved business thread', sentAt: '2026-10-05T12:00:00Z' }])
  assert.deepEqual((await linkedin.list('all')).map(row => row.id), [id])
  assert.deepEqual((await linkedin.list('linkedin')).map(row => row.id), [id])
})

test('replied email thread stays visible after sent followup and retains complete conversation context', async t => {
  const f = await fixture(t)
  const messages: Message[] = [
    { direction: 'sent', bodyText: 'Initial cold email' },
    { direction: 'received', bodyText: 'Please tell me more' },
    { direction: 'sent', bodyText: 'Human followup after reply' },
  ]
  const id = await f.conversation(messages.map((message, index) => ({ ...message, sentAt: `2026-10-05T12:0${index}:00Z` })))
  for (const channel of ['all', 'email'] as const) {
    const rows = await f.list(channel)
    assert.deepEqual(rows.map(row => row.id), [id])
    assert.equal(rows[0].preview, 'Human followup after reply')
  }
  const detail = await f.tenant.supabase.rpc('read_outreach_conversation', { p_client_id: f.tenant.client.id, p_conversation_id: id })
  assert.ifError(detail.error)
  const received = (detail.data as unknown as { messages: Message[] }).messages
  assert.deepEqual(received.map(({ direction, bodyText }) => ({ direction, bodyText })), messages)
})

test('sent-only email threads cannot starve reply inbox keyset pages', async t => {
  const f = await fixture(t)
  const expected: string[] = []
  for (let day = 9; day >= 7; day--) {
    expected.push(await f.conversation([{ direction: 'received', bodyText: `Reply ${day}`, sentAt: `2026-10-0${day}T12:00:00Z` }]))
  }
  for (const day of [10, 11, 12, 13, 14]) {
    await f.conversation([{ direction: 'sent', bodyText: 'Newer cold email', sentAt: `2026-10-${day}T12:00:00Z` }])
  }
  for (const channel of ['all', 'email'] as const) {
    const first = await f.list(channel, 2)
    assert.deepEqual(first.map(row => row.id), expected.slice(0, 2))
    const second = await f.list(channel, 2, first[1])
    assert.deepEqual(second.map(row => row.id), expected.slice(2))
    assert.deepEqual(await f.list(channel, 2, second[0]), [])
  }
})
