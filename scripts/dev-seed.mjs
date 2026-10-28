// Development-only seed/reset: one admin, two users, prospects, sender mailboxes,
// sample Inbox threads and matching mock sending-engine state.
// Usage: npm run dev:seed            (reset + seed)
//        npm run dev:seed -- --clear (remove seed data only)
import { loadEnvFile } from 'node:process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

if (existsSync('.env.local')) loadEnvFile('.env.local')
const CONTENT_PORTAL_PROJECT = 'stfygrdsjgrmmawvnifc'
const MOCK_WORKSPACE_ID = '0c0ffee0-0000-4000-8000-000000000001'
const CLIENT_ID = 'c0ffee00-0000-4000-8000-0000000000c1'
const CREDENTIAL_REF = 'OUTREACH_INSTANTLY_COVORA'
const SEED_USERS = [
  { key: 'admin', email: 'admin@covora.test', password: 'CovoraDevAdmin#2026', name: 'Dev Admin' },
  { key: 'alice', email: 'alice@covora.test', password: 'CovoraDevAlice#2026', name: 'Alice Dev', sender: 'alice.sender@covora-mock.test' },
  { key: 'bob', email: 'bob@covora.test', password: 'CovoraDevBob#2026!', name: 'Bob Dev', sender: 'bob.sender@covora-mock.test' },
]
const PROSPECTS = [
  { first: 'Priya', last: 'Shah', company: 'Northwind', email: 'priya@prospect-mock.test' },
  { first: 'Marco', last: 'Rossi', company: 'Fabrikam', email: 'marco@prospect-mock.test' },
  { first: 'Lena', last: 'Novak', company: 'Contoso', email: 'lena@prospect-mock.test' },
  { first: 'Omar', last: 'Haddad', company: 'Tailspin', email: 'omar@prospect-mock.test' },
]

function refuse(message) { console.error(`Refusing to seed: ${message}`); process.exit(1) }
const env = process.env
const ref = env.OUTREACH_SUPABASE_PROJECT_REF?.trim()
const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim()
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim()
if (env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production') refuse('production environment.')
if (!ref || !url || !serviceKey) refuse('database settings are missing from .env.local.')
if (ref === CONTENT_PORTAL_PROJECT || url.includes(CONTENT_PORTAL_PROJECT)) refuse('that is the content portal database.')
// Explicit opt-in: the dev project's ref must be repeated in OUTREACH_DEV_SEED_PROJECT_REF.
if (env.OUTREACH_DEV_SEED_PROJECT_REF?.trim() !== ref) refuse('set OUTREACH_DEV_SEED_PROJECT_REF to this development project ref in .env.local.')
const host = new URL(url)
const localStack = ref === 'local-outreach' && host.hostname === '127.0.0.1' && host.port === '60321'
if (!localStack && host.hostname !== `${ref}.supabase.co`) refuse('database URL does not match the project ref.')

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
const check = (label, result) => { if (result.error) throw new Error(`${label}: ${result.error.message}`); return result.data }

// A real workspace with any other client is never a development target.
const clients = check('read clients', await admin.from('clients').select('id').neq('id', CLIENT_ID).limit(1))
if (clients.length) refuse('this database contains non-seed clients. Use an empty development project.')

function threadKey(campaignId, providerThreadId) {
  const hash = createHash('sha256').update(`${campaignId}\u0000${providerThreadId}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
const sha = value => createHash('sha256').update(value).digest('hex')

async function clear() {
  check('remove client', await admin.from('clients').delete().eq('id', CLIENT_ID))
  const seeded = new Set(SEED_USERS.map(user => user.email))
  for (let page = 1; page < 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`list users: ${error.message}`)
    for (const user of data.users) if (seeded.has(user.email)) check('remove user', await admin.auth.admin.deleteUser(user.id))
    if (data.users.length < 200) break
  }
}

async function seed() {
  const workspaceId = env.OUTREACH_DEV_INSTANTLY_WORKSPACE_ID?.trim() || MOCK_WORKSPACE_ID
  const users = {}
  for (const user of SEED_USERS) {
    const created = await admin.auth.admin.createUser({ email: user.email, password: user.password, email_confirm: true, user_metadata: { full_name: user.name } })
    if (created.error || !created.data.user) throw new Error(`create ${user.key}: ${created.error?.message}`)
    users[user.key] = { ...user, id: created.data.user.id }
    check('profile', await admin.from('profiles').upsert({ id: created.data.user.id, full_name: user.name }))
  }
  check('client', await admin.from('clients').insert({ id: CLIENT_ID, name: 'Covora · Dev', slug: 'covora-dev' }))
  check('features', await admin.from('client_features').insert([
    { client_id: CLIENT_ID, feature: 'outreach_app', enabled: true },
    { client_id: CLIENT_ID, feature: 'outreach_portal_inbox', enabled: true },
  ]))
  check('agency owner', await admin.from('outreach_agency_memberships').upsert({ user_id: users.admin.id, role: 'owner', state: 'active' }))
  check('memberships', await admin.from('outreach_memberships').insert([
    { user_id: users.alice.id, client_id: CLIENT_ID, role: 'client_member', state: 'active' },
    { user_id: users.bob.id, client_id: CLIENT_ID, role: 'client_member', state: 'active' },
  ]))
  check('account workspace', await admin.from('outreach_account_workspaces').insert({ client_id: CLIENT_ID, credential_ref: CREDENTIAL_REF, remote_workspace_id: workspaceId, enabled: true }))
  const binding = check('reply workspace', await admin.from('outreach_reply_workspaces').insert({ client_id: CLIENT_ID, channel: 'email',
    remote_workspace_id: workspaceId, credential_ref: CREDENTIAL_REF, enabled: true, sync_enabled: true }).select('id').single())

  const people = check('people', await admin.from('outreach_people').select('id,user_id').eq('client_id', CLIENT_ID))
  for (const key of ['alice', 'bob']) {
    const person = people.find(item => item.user_id === users[key].id)
    if (!person) throw new Error(`team person for ${key} was not created`)
    const connection = check('connection', await admin.from('outreach_connections').insert({ person_id: person.id, client_id: CLIENT_ID, channel: 'email',
      expected_email: users[key].sender, remote_account: users[key].sender, actor_id: users.admin.id, authority_stamp: 'dev-seed', workspace_version: 1, state: 'connected' }).select('id').single())
    users[key].connectionId = connection.id
    check('sender', await admin.from('outreach_reply_senders').insert({ client_id: CLIENT_ID, channel: 'email', workspace_id: binding.id,
      remote_sender_id: users[key].sender, sender_address: users[key].sender, sender_label: users[key].name, enabled: true }))
  }

  const listId = randomUUID()
  check('lead list', await admin.from('outreach_lead_lists').insert({ id: listId, client_id: CLIENT_ID, name: 'Dev prospects', source_sha256: sha('covora-dev-prospects') }))
  const leads = PROSPECTS.map(prospect => ({ ...prospect, id: randomUUID() }))
  check('prospects', await admin.from('outreach_imported_leads').insert(leads.map(lead => ({ id: lead.id, client_id: CLIENT_ID, list_id: listId,
    source_row_id: sha(lead.email), first_name: lead.first, last_name: lead.last, company: lead.company, email: lead.email }))))

  const mock = { version: 1, workspaceId, accounts: [users.alice.sender, users.bob.sender], campaigns: {}, leads: {}, emails: [] }
  const minutesAgo = minutes => new Date(Date.now() - minutes * 60_000).toISOString()
  // Alice and Bob each own one portal thread; a third, admin-assigned campaign must stay hidden.
  const threads = [
    { owner: 'alice', lead: leads[0], origin: 'portal', subject: 'Quick idea for Northwind', sent: 'Hi Priya, would a short call next week be useful?', reply: 'Sounds interesting - Tuesday works for me.' },
    { owner: 'bob', lead: leads[1], origin: 'portal', subject: 'Fabrikam outreach', sent: 'Hi Marco, sharing a quick case study for Fabrikam.', reply: 'Thanks Bob, can you send pricing?' },
    { owner: 'alice', lead: leads[2], origin: 'assigned', subject: 'Campaign not started in Covora', sent: 'This thread came from an assigned campaign.', reply: 'This must not appear in the portal-only Inbox.' },
  ]
  for (const [index, thread] of threads.entries()) {
    const owner = users[thread.owner]
    const providerCampaignId = randomUUID(), providerLeadId = randomUUID(), providerThreadId = randomUUID()
    const sentId = randomUUID(), replyId = randomUUID()
    const name = thread.origin === 'portal' ? `Covora outreach ${providerCampaignId.slice(0, 8)}` : 'Assigned dev campaign'
    const campaign = check('campaign', await admin.from('outreach_campaigns').insert({ client_id: CLIENT_ID, provider_campaign_id: providerCampaignId, name,
      status: 'active', channel: 'email', origin: thread.origin, started_by: thread.origin === 'portal' ? owner.id : null }).select('id').single())
    const sentAt = minutesAgo(120 - index * 10), replyAt = minutesAgo(60 - index * 10)
    if (thread.origin === 'portal') {
      check('portal send', await admin.from('outreach_portal_sends').insert({ id: randomUUID(), client_id: CLIENT_ID, actor_user_id: owner.id, authority_stamp: 'dev-seed',
        connection_id: owner.connectionId, lead_id: thread.lead.id, sender_address: owner.sender, recipient_email: thread.lead.email,
        recipient_first_name: thread.lead.first, recipient_last_name: thread.lead.last, recipient_company: thread.lead.company,
        subject: thread.subject, body_text: thread.sent, status: 'scheduled', campaign_id: campaign.id, provider_campaign_id: providerCampaignId, provider_lead_id: providerLeadId }))
    }
    const base = { campaign_id: campaign.id, client_id: CLIENT_ID, provider_thread_id: providerThreadId, provider_account: owner.sender,
      thread_key: threadKey(campaign.id, providerThreadId), lead_email: thread.lead.email, subject: thread.subject }
    check('sent message', await admin.from('outreach_messages').insert({ ...base, provider_email_id: sentId, direction: 'sent', from_email: owner.sender, to_email: thread.lead.email, body_text: thread.sent, sent_at: sentAt }))
    check('reply message', await admin.from('outreach_messages').insert({ ...base, provider_email_id: replyId, direction: 'received', from_email: thread.lead.email, to_email: owner.sender, subject: `Re: ${thread.subject}`, body_text: thread.reply, sent_at: replyAt }))
    mock.campaigns[providerCampaignId] = { id: providerCampaignId, name, status: 1, organization: workspaceId, email_list: [owner.sender], email_tag_list: [],
      sequences: [{ steps: [{ type: 'email', delay: 0, variants: [{ subject: thread.subject, body: thread.sent }] }] }], campaign_schedule: null, timestamp_created: sentAt, timestamp_updated: sentAt }
    mock.leads[providerLeadId] = { id: providerLeadId, email: thread.lead.email, campaign: providerCampaignId, first_name: thread.lead.first, last_name: thread.lead.last, company_name: thread.lead.company, status: 1, timestamp_created: sentAt }
    const email = { organization_id: workspaceId, campaign_id: providerCampaignId, lead: thread.lead.email, lead_id: providerLeadId, eaccount: owner.sender, thread_id: providerThreadId, is_auto_reply: 0, i_status: null, is_unread: 0 }
    mock.emails.push({ ...email, id: sentId, timestamp_created: sentAt, timestamp_email: sentAt, subject: thread.subject, from_address_email: owner.sender, to_address_email_list: thread.lead.email, body: { text: thread.sent }, ue_type: 1 })
    mock.emails.push({ ...email, id: replyId, timestamp_created: replyAt, timestamp_email: replyAt, subject: `Re: ${thread.subject}`, from_address_email: thread.lead.email, to_address_email_list: owner.sender, body: { text: thread.reply }, ue_type: 2 })
  }
  const file = path.resolve(env.OUTREACH_INSTANTLY_MOCK_STATE?.trim() || '.mock-instantly.json')
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(mock, null, 2) + '\n')
  renameSync(temporary, file)
  return users
}

await clear()
if (process.argv.includes('--clear')) {
  console.log('Removed development seed data.')
} else {
  await seed()
  console.log('Seeded development workspace "Covora · Dev". Development-only logins:')
  for (const user of SEED_USERS) console.log(`  ${user.key.padEnd(5)}  ${user.email}  ${user.password}${user.sender ? `  (sender ${user.sender})` : ''}`)
  console.log('Mock sending-engine state written to .mock-instantly.json.')
}
