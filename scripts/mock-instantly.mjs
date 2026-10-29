// Development-only helpers for the mock sending engine. Nothing here contacts Instantly.
//   npm run mock -- reply <prospect-email> ["text"] [--twice] [--no-webhook]
//   npm run mock -- outside <prospect-email>   reply from a campaign created outside Covora
//   npm run mock -- unrelated                  ordinary mail into a sender mailbox
//   npm run mock -- sync                       run the backup sync once
//   npm run mock -- status
import { loadEnvFile } from 'node:process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

if (existsSync('.env.local')) loadEnvFile('.env.local')
const env = process.env
if (env.NODE_ENV === 'production') throw new Error('Mock helpers are development-only.')
if ((env.OUTREACH_INSTANTLY_MODE ?? '').trim().toLowerCase() !== 'mock') throw new Error('Set OUTREACH_INSTANTLY_MODE=mock in .env.local first.')
const origin = (env.OUTREACH_DEV_API_ORIGIN ?? 'http://127.0.0.1:3011').replace(/\/$/, '')
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) throw new Error('Mock helpers only call a local backend.')
const file = path.resolve(env.OUTREACH_INSTANTLY_MOCK_STATE?.trim() || '.mock-instantly.json')
const [command, ...rest] = process.argv.slice(2)
const flags = new Set(rest.filter(arg => arg.startsWith('--')))
const args = rest.filter(arg => !arg.startsWith('--'))

function readState() {
  if (!existsSync(file)) throw new Error('No mock state yet. Run npm run dev:seed first.')
  return JSON.parse(readFileSync(file, 'utf8'))
}
function writeState(state) {
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n')
  renameSync(temporary, file)
}
function receive(state, { campaignId, lead, eaccount, threadId, subject, text }) {
  const now = new Date().toISOString()
  const email = { id: randomUUID(), organization_id: state.workspaceId, timestamp_created: now, timestamp_email: now, subject,
    from_address_email: lead, to_address_email_list: eaccount, body: { text }, campaign_id: campaignId, lead, lead_id: null,
    eaccount, ue_type: 2, thread_id: threadId, is_auto_reply: 0, i_status: null, is_unread: 1 }
  state.emails.push(email)
  return email
}
async function webhook(payload) {
  const secret = env.OUTREACH_INSTANTLY_WEBHOOK_SECRET
  if (!secret) throw new Error('Set OUTREACH_INSTANTLY_WEBHOOK_SECRET in .env.local.')
  const response = await fetch(`${origin}/api/webhooks/instantly`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-covora-webhook-secret': secret }, body: JSON.stringify(payload) })
  console.log(`webhook -> ${response.status} ${await response.text()}`)
}
const payloadFor = (email, campaignName) => ({ event_type: 'reply_received', timestamp: email.timestamp_created, workspace: email.organization_id,
  campaign_id: email.campaign_id, campaign_name: campaignName, lead_email: email.lead, email_account: email.eaccount, email_id: email.id,
  reply_subject: email.subject, reply_text: email.body.text })

if (command === 'reply') {
  const lead = args[0]?.toLowerCase()
  if (!lead) throw new Error('Usage: npm run mock -- reply <prospect-email> ["text"]')
  const state = readState()
  const latest = state.emails.filter(email => email.lead === lead && email.campaign_id && email.ue_type !== 2)
    .sort((a, b) => b.timestamp_created.localeCompare(a.timestamp_created))[0]
  if (!latest) throw new Error(`No sent mock email to ${lead}. Start an outreach to this prospect first.`)
  const email = receive(state, { campaignId: latest.campaign_id, lead, eaccount: latest.eaccount, threadId: latest.thread_id,
    subject: latest.subject.startsWith('Re:') ? latest.subject : `Re: ${latest.subject}`, text: args[1] ?? 'Thanks - happy to chat this week.' })
  writeState(state)
  console.log(`Prospect ${lead} replied in thread ${latest.thread_id}.`)
  if (flags.has('--no-webhook')) console.log('Webhook skipped (simulated missed event). Run: npm run mock -- sync')
  else {
    const payload = payloadFor(email, state.campaigns[latest.campaign_id]?.name)
    await webhook(payload)
    if (flags.has('--twice')) await webhook(payload)
  }
} else if (command === 'outside') {
  const lead = args[0]?.toLowerCase() ?? 'omar@prospect-mock.test'
  const state = readState()
  const eaccount = state.accounts[0]
  const now = new Date().toISOString(), campaignId = randomUUID(), threadId = randomUUID()
  state.campaigns[campaignId] = { id: campaignId, name: 'Created directly in Instantly', status: 1, organization: state.workspaceId, email_list: [eaccount],
    email_tag_list: [], sequences: [], campaign_schedule: null, timestamp_created: now, timestamp_updated: now }
  state.emails.push({ id: randomUUID(), organization_id: state.workspaceId, timestamp_created: now, timestamp_email: now, subject: 'Outside campaign',
    from_address_email: eaccount, to_address_email_list: lead, body: { text: 'Sent from a campaign Covora did not create.' }, campaign_id: campaignId,
    lead, lead_id: null, eaccount, ue_type: 1, thread_id: threadId, is_auto_reply: 0, i_status: null, is_unread: 0 })
  const email = receive(state, { campaignId, lead, eaccount, threadId, subject: 'Re: Outside campaign', text: 'Reply to an outside campaign.' })
  writeState(state)
  await webhook(payloadFor(email, 'Created directly in Instantly'))
  console.log('Expected: result "ignored" and nothing new in the Covora Inbox.')
} else if (command === 'unrelated') {
  const state = readState()
  const eaccount = state.accounts[0]
  const email = receive(state, { campaignId: null, lead: 'someone@unrelated-mock.test', eaccount, threadId: randomUUID(), subject: 'Lunch?', text: 'Unrelated personal email.' })
  writeState(state)
  await webhook({ ...payloadFor(email), campaign_id: undefined })
  console.log('Expected: result "ignored" and nothing new in the Covora Inbox.')
} else if (command === 'sync') {
  await import('./dev-sync.mjs')
} else if (command === 'status') {
  const state = readState()
  console.log(`accounts: ${state.accounts.join(', ')}`)
  console.log(`campaigns: ${Object.keys(state.campaigns).length}, leads: ${Object.keys(state.leads).length}, emails: ${state.emails.length}`)
  for (const email of state.emails.slice(-8)) console.log(`  ${email.timestamp_created}  ${['', 'sent', 'received', 'reply'][email.ue_type]}  ${email.eaccount} <-> ${email.lead}  ${email.subject}`)
} else {
  console.log('Commands: reply <prospect-email> ["text"] [--twice] [--no-webhook] | outside [prospect-email] | unrelated | sync | status')
}
