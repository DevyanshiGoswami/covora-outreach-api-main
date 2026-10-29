// Development-only positive/denied checks with the seeded logins (run after npm run dev:seed).
// Uses the public anon key and each user's own session, exactly like the frontend.
import { loadEnvFile } from 'node:process'
import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'

if (existsSync('.env.local')) loadEnvFile('.env.local')
const env = process.env
if (env.NODE_ENV === 'production' || env.OUTREACH_DEV_SEED_PROJECT_REF?.trim() !== env.OUTREACH_SUPABASE_PROJECT_REF?.trim()) throw new Error('Development project only.')
const CLIENT_ID = 'c0ffee00-0000-4000-8000-0000000000c1'
const origin = (env.OUTREACH_DEV_API_ORIGIN ?? 'http://127.0.0.1:3011').replace(/\/$/, '')
const logins = { admin: ['admin@covora.test', 'CovoraDevAdmin#2026'], alice: ['alice@covora.test', 'CovoraDevAlice#2026'], bob: ['bob@covora.test', 'CovoraDevBob#2026!'] }
let failures = 0
async function check(name, run) {
  try { await run(); console.log(`PASS  ${name}`) } catch (error) { failures++; console.log(`FAIL  ${name}: ${error.message}`) }
}
async function login(key) {
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await client.auth.signInWithPassword({ email: logins[key][0], password: logins[key][1] })
  if (error) throw new Error(`login ${key}: ${error.message}`)
  return { client, token: data.session.access_token }
}
const users = { admin: await login('admin'), alice: await login('alice'), bob: await login('bob') }
async function inbox(key) {
  const { data, error } = await users[key].client.rpc('list_outreach_conversations', { p_client_id: CLIENT_ID, p_channel: 'all', p_limit: 51 })
  if (error) throw new Error(error.message)
  return data
}
const subjects = list => list.map(item => item.subject).sort()

const [alice, bob, admin] = [await inbox('alice'), await inbox('bob'), await inbox('admin')]
const aliceThread = alice[0]
await check('alice sees only her own portal thread', () => assert.deepEqual(subjects(alice), ['Quick idea for Northwind']))
await check('bob sees only his own portal thread', () => assert.deepEqual(subjects(bob), ['Fabrikam outreach']))
await check('admin sees both portal threads and not the non-portal campaign', () => assert.deepEqual(subjects(admin), ['Fabrikam outreach', 'Quick idea for Northwind']))
await check('bob cannot open alice\'s conversation', async () => {
  const { error } = await users.bob.client.rpc('read_outreach_conversation', { p_client_id: CLIENT_ID, p_conversation_id: aliceThread.id, p_limit: 100 })
  assert.equal(error?.code, '42501')
})
await check('bob cannot reply to alice\'s conversation', async () => {
  const { error } = await users.bob.client.rpc('enqueue_outreach_reply', { p_client_id: CLIENT_ID, p_conversation_id: aliceThread.id, p_command_id: crypto.randomUUID(),
    p_expected_version: aliceThread.version, p_latest_message_id: aliceThread.latestMessageId, p_body: 'Not allowed', p_takeover: true })
  assert.ok(error, 'expected a denial')
})
await check('alice owns her thread, so she can reply without takeover', () => assert.equal(aliceThread.ownedByMe && aliceThread.canReply, true))
await check('alice is offered only her own sender', async () => {
  const { data, error } = await users.alice.client.rpc('portal_outreach_options', { p_client_id: CLIENT_ID })
  if (error) throw new Error(error.message)
  assert.deepEqual(data.senders.map(item => item.address), ['alice.sender@covora-mock.test'])
  assert.equal(data.prospects.length, 4)
})
await check('alice cannot start outreach from bob\'s sender', async () => {
  const { data } = await users.bob.client.rpc('portal_outreach_options', { p_client_id: CLIENT_ID })
  const { error } = await users.alice.client.rpc('enqueue_portal_outreach', { p_client_id: CLIENT_ID, p_send_id: crypto.randomUUID(),
    p_lead_id: (await users.alice.client.rpc('portal_outreach_options', { p_client_id: CLIENT_ID })).data.prospects[0].id,
    p_connection_id: data.senders[0].connectionId, p_subject: 'Hi', p_body: 'Hello' })
  assert.equal(error?.code, '42501')
})
await check('bob\'s outreach history excludes alice\'s', async () => {
  const { data, error } = await users.bob.client.rpc('list_portal_outreach', { p_client_id: CLIENT_ID })
  if (error) throw new Error(error.message)
  assert.deepEqual(data.map(item => item.recipientEmail), ['marco@prospect-mock.test'])
})
await check('backend API applies the same isolation (needs npm run dev)', async () => {
  const response = await fetch(`${origin}/api/outbound/conversations?clientId=${CLIENT_ID}&channel=all`, { headers: { Authorization: `Bearer ${users.bob.token}` } })
  assert.equal(response.status, 200)
  assert.deepEqual(subjects((await response.json()).conversations), ['Fabrikam outreach'])
  const denied = await fetch(`${origin}/api/outbound/conversations/${aliceThread.id}?clientId=${CLIENT_ID}`, { headers: { Authorization: `Bearer ${users.bob.token}` } })
  assert.equal(denied.status, 403)
})
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll isolation checks passed.')
process.exitCode = failures ? 1 : 0

