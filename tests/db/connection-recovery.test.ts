import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { adminClient, anonClient } from '../helpers/admin'
import { createTenant } from '../helpers/tenants'
import { grantOutreachMembership } from '../helpers/outreach'
import { loadTestEnv } from '../helpers/env'
import { createOnboardingHandlers } from '../../src/lib/onboarding-api'
import type { Database } from '../../src/lib/database.types'

const env = loadTestEnv()
const admin = adminClient()
type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>
type Route = [RegExp, Handler]
function provider(routes: Route[], calls: string[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input)); const key = `${init?.method ?? 'GET'} ${url.pathname.replace(/^\/api\/(v2|public)/, '')}`
    calls.push(key)
    for (const [pattern, handler] of routes) if (pattern.test(key)) return handler(url, init)
    throw new Error(`Unexpected provider request ${key}`)
  }
}
const down: Handler = () => { throw new TypeError('fetch failed') }
const json = (body: unknown, status = 200) => () => Response.json(body, { status })
const senders = (list: { id: number; emailAddress?: string | null }[]): Route => [/^POST \/li_account\/GetAll$/, () => Response.json({ totalCount: list.length, items: list })]
const connect = (h: Handler): Route => [/^POST \/li_account\/Connect(WithCookies)?$/, h]
const liStatus = (h: Handler): Route => [/^GET \/li_account\/GetAccountStatus\//, h]
const li = (id: number, state: string, profileUrl: string | null = null) => json({ accountId: id, status: state, failureReason: null, profile: { fullName: null, email: null, profileUrl, avatarUrl: null } })
const getById = (h: Handler): Route => [/^GET \/li_account\/GetById$/, h]
const remove = (h: Handler): Route => [/^DELETE \/li_account\/RemoveAccount\//, h]
const ws = (w: string): Route => [/^GET \/workspaces\/current$/, json({ id: w })]
const init = (p: string): Route => [new RegExp(`^POST /oauth/${p}/init$`), () => Response.json({ session_id: randomUUID(), expires_at: new Date(Date.now() + 600000).toISOString(),
  auth_url: p === 'microsoft' ? 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=s' : 'https://accounts.google.com/o/oauth2/v2/auth?state=s' })]
const mailbox = (h: Handler): Route => [/^GET \/accounts\//, h]

async function person(t: Parameters<typeof createTenant>[0], shared?: { workspace: string; linkedinWorkspace: string }) {
  const tenant = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(tenant.user.id, tenant.client.id)
  const workspace = shared?.workspace ?? randomUUID(), linkedinWorkspace = shared?.linkedinWorkspace ?? randomUUID()
  assert.ifError((await admin.from('outreach_account_workspaces').insert({ client_id: tenant.client.id, credential_ref: 'OUTREACH_INSTANTLY_TEST', remote_workspace_id: workspace, enabled: true })).error)
  assert.ifError((await admin.from('outreach_reply_workspaces').insert({ client_id: tenant.client.id, channel: 'linkedin', credential_ref: 'OUTREACH_HEYREACH_TEST', remote_workspace_id: linkedinWorkspace, enabled: true })).error)
  const created = await tenant.supabase.rpc('create_outreach_person', { p_client_id: tenant.client.id, p_name: 'Test person', p_email: tenant.user.email })
  assert.ifError(created.error)
  return { ...tenant, workspace, linkedinWorkspace, person: created.data! as string, email: tenant.user.email }
}
const handlers = (routes: Route[], calls: string[] = []) => createOnboardingHandlers({ url: env.URL, anonKey: env.ANON, serviceKey: env.SERVICE, fetch,
  providerFetch: provider(routes, calls), credentials: { OUTREACH_INSTANTLY_TEST: 'synthetic', OUTREACH_HEYREACH_TEST: 'synthetic' } })
async function act(h: ReturnType<typeof handlers>, session: ReturnType<typeof anonClient>, body: Record<string, unknown>) {
  const token = (await session.auth.getSession()).data.session!.access_token
  const response = await h.connection(new Request('http://localhost/api/onboarding/connections', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  return { http: response.status, ...(await response.json().catch(() => ({}))) } as { http: number; state?: string; failureCode?: string; reviewStatus?: string; authUrl?: string | null }
}
async function latest(personId: string, channel: string) {
  const row = await admin.from('outreach_connections').select('id,state,remote_account').eq('person_id', personId).eq('channel', channel).order('created_at', { ascending: false }).limit(1).single()
  assert.ifError(row.error); return row.data!
}
const touch = async (personId: string, channel: string, patch: Database['public']['Tables']['outreach_connections']['Update']) => {
  assert.ifError((await admin.from('outreach_connections').update(patch).eq('id', (await latest(personId, channel)).id)).error)
}
const pollReady = (p: string, c: string) => touch(p, c, { next_poll_at: new Date(0).toISOString() })
const cooledDown = (p: string, c: string) => touch(p, c, { created_at: new Date(Date.now() - 61000).toISOString() })
const windowPassed = (p: string, c: string) => touch(p, c, { expires_at: new Date(Date.now() - 1000).toISOString(), created_at: new Date(Date.now() - 700000).toISOString() })
const password = (personId: string, email: string) => ({ action: 'start', personId, channel: 'linkedin', email, password: 'synthetic-password', country: 'US' })
const liPoll = (personId: string) => ({ action: 'poll', personId, channel: 'linkedin' })
const liReview = (personId: string) => ({ action: 'review', personId, channel: 'linkedin' })

test('a lost LinkedIn connect with nothing created waits out its window, then expires and can be retried', async t => {
  const s = await person(t)
  assert.equal((await act(handlers([senders([]), connect(down)]), s.supabase, password(s.person, s.email))).state, 'uncertain')
  const h = handlers([senders([{ id: 9, emailAddress: 'someone-else@example.test' }]), connect(json({ linkedInAccountId: 601 }))])
  await pollReady(s.person, 'linkedin')
  const early = await act(h, s.supabase, liReview(s.person))
  assert.deepEqual([early.state, early.reviewStatus], ['uncertain', 'waiting'])
  await windowPassed(s.person, 'linkedin'); await pollReady(s.person, 'linkedin')
  const late = await act(h, s.supabase, liReview(s.person))
  assert.deepEqual([late.state, late.reviewStatus], ['expired', 'missing'])
  assert.equal((await act(h, s.supabase, password(s.person, s.email))).state, 'pending')
})

test('a lost LinkedIn connect is recovered from the sender carrying the login, then verified by status checks', async t => {
  const s = await person(t)
  await act(handlers([senders([]), connect(down)]), s.supabase, password(s.person, s.email))
  const h = handlers([senders([{ id: 602, emailAddress: s.email }]), liStatus(li(602, 'Connected', 'https://www.linkedin.com/in/test-person'))])
  await pollReady(s.person, 'linkedin')
  const restored = await act(h, s.supabase, liReview(s.person))
  assert.deepEqual([restored.state, restored.reviewStatus], ['pending', 'restored'])
  const row = await latest(s.person, 'linkedin'); assert.equal(row.remote_account, '602')
  assert.equal((await act(h, s.supabase, liPoll(s.person))).state, 'connected')
})

test('an attempt whose request died after HeyReach accepted it is restored with its known sender', async t => {
  const s = await person(t)
  const h = handlers([senders([]), connect(json({ linkedInAccountId: 603 })), liStatus(li(603, 'Connected', 'https://www.linkedin.com/in/test-person'))])
  await act(h, s.supabase, password(s.person, s.email))
  await touch(s.person, 'linkedin', { state: 'pending', lease_id: randomUUID(), lease_until: new Date(Date.now() - 1000).toISOString() })
  assert.equal((await act(h, s.supabase, liPoll(s.person))).state, 'uncertain')
  await pollReady(s.person, 'linkedin')
  assert.equal((await act(h, s.supabase, liReview(s.person))).reviewStatus, 'restored')
  assert.equal((await act(h, s.supabase, liPoll(s.person))).state, 'connected')
})

test('a challenged sign-in stays pending and an older failed observation resumes the same login for verification', async t => {
  const s = await person(t), outsider = await createTenant(t, { features: ['outreach_app'] }), calls: string[] = []
  let status = 'Challenged'
  const h = handlers([senders([]), connect(json({ linkedInAccountId: 613 })),
    liStatus(() => Response.json({ accountId: 613, status, failureReason: status === 'Challenged' ? 'Verification required' : null,
      profile: { profileUrl: status === 'Connected' ? 'https://www.linkedin.com/in/test-person' : null } })),
    [/^POST \/li_account\/SubmitPin$/, (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { accountId: 613, pin: '123456' })
      status = 'Syncing'; return new Response(null, { status: 204 })
    }],
  ], calls)
  await act(h, s.supabase, password(s.person, s.email)); await pollReady(s.person, 'linkedin')
  assert.equal((await act(h, s.supabase, liPoll(s.person))).state, 'pending')
  // Reproduce the old version's terminal classification, not a manual repair.
  await touch(s.person, 'linkedin', { state: 'failed' }); await cooledDown(s.person, 'linkedin'); await pollReady(s.person, 'linkedin')
  const before = await latest(s.person, 'linkedin'), beforeCalls = calls.length
  assert.equal((await act(h, outsider.supabase, liReview(s.person))).http, 403); assert.equal(calls.length, beforeCalls)
  assert.equal((await act(h, s.supabase, password(s.person, 'different@example.test'))).failureCode, 'linkedin_identity_locked')
  assert.equal(calls.length, beforeCalls)
  const review = await act(h, s.supabase, liReview(s.person))
  assert.deepEqual([review.state, review.reviewStatus], ['pending', 'restored'])
  assert.equal((await latest(s.person, 'linkedin')).id, before.id)
  assert.equal((await latest(s.person, 'linkedin')).remote_account, '613')
  assert.equal((await admin.from('outreach_connection_reservations').select('email').eq('person_id', s.person).single()).data?.email, s.email)
  assert.equal((await act(h, s.supabase, { action: 'pin', personId: s.person, channel: 'linkedin', pin: '123456' })).state, 'pending')
  status = 'Connected'; await pollReady(s.person, 'linkedin')
  assert.equal((await act(h, s.supabase, liPoll(s.person))).state, 'connected')
  assert.equal(calls.filter(c => c === 'POST /li_account/Connect').length, 1)
  assert.equal(calls.filter(c => c === 'POST /li_account/SubmitPin').length, 1)
  assert.equal(calls.some(c => c.startsWith('DELETE')), false)
})

test('review of a genuinely failed sender keeps its state and login reservation', async t => {
  const s = await person(t), calls: string[] = []
  const h = handlers([senders([]), connect(json({ linkedInAccountId: 614 })), liStatus(li(614, 'Disconnected'))], calls)
  await act(h, s.supabase, password(s.person, s.email)); await pollReady(s.person, 'linkedin')
  assert.equal((await act(h, s.supabase, liPoll(s.person))).state, 'failed')
  await pollReady(s.person, 'linkedin')
  const review = await act(h, s.supabase, liReview(s.person))
  assert.deepEqual([review.state, review.reviewStatus], ['failed', 'unavailable'])
  assert.equal((await admin.from('outreach_connection_reservations').select('email').eq('person_id', s.person).single()).data?.email, s.email)
  assert.equal(calls.filter(c => c === 'POST /li_account/Connect').length, 1)
  assert.equal(calls.some(c => c.startsWith('DELETE')), false)
})

test('review leases block new logins and require the existing identity reservation', async t => {
  const s = await person(t)
  const h = handlers([senders([]), connect(json({ linkedInAccountId: 615 })), liStatus(li(615, 'Disconnected'))])
  await act(h, s.supabase, password(s.person, s.email)); await pollReady(s.person, 'linkedin')
  await act(h, s.supabase, liPoll(s.person)); await pollReady(s.person, 'linkedin'); await cooledDown(s.person, 'linkedin')
  const claim = await s.supabase.rpc('prepare_outreach_linkedin_review', { p_person: s.person })
  assert.ifError(claim.error); assert.ok(claim.data![0].claim_token)
  const calls: string[] = []
  const concurrent = await act(handlers([], calls), s.supabase, password(s.person, s.email))
  assert.deepEqual([concurrent.http, concurrent.failureCode], [400, 'linkedin_check_in_progress'])
  assert.deepEqual(calls, [])
  assert.equal((await admin.rpc('finish_outreach_linkedin_review', { p_id: claim.data![0].connection_id,
    p_lease: claim.data![0].claim_token!, p_outcome: 'unavailable' })).data, true)
  await pollReady(s.person, 'linkedin')
  assert.ifError((await admin.from('outreach_connection_reservations').delete().eq('person_id', s.person)).error)
  assert.equal((await s.supabase.rpc('prepare_outreach_linkedin_review', { p_person: s.person })).error?.code, '42501')
})

test('an expired verification window can resume its exact still-challenged sender without another login', async t => {
  const s = await person(t), calls: string[] = []
  const h = handlers([senders([]), connect(json({ linkedInAccountId: 616 })), liStatus(li(616, 'Challenged'))], calls)
  await act(h, s.supabase, password(s.person, s.email)); await windowPassed(s.person, 'linkedin'); await pollReady(s.person, 'linkedin')
  assert.equal((await act(h, s.supabase, liPoll(s.person))).state, 'expired')
  const previous = await latest(s.person, 'linkedin')
  const claim = await s.supabase.rpc('prepare_outreach_linkedin_review', { p_person: s.person })
  assert.ifError(claim.error); assert.ok(claim.data![0].claim_token)
  assert.equal((await act(h, s.supabase, password(s.person, s.email))).failureCode, 'linkedin_check_in_progress')
  assert.equal((await admin.rpc('finish_outreach_linkedin_review', { p_id: previous.id,
    p_lease: claim.data![0].claim_token!, p_outcome: 'unavailable' })).data, true)
  assert.equal((await latest(s.person, 'linkedin')).state, 'expired')
  await pollReady(s.person, 'linkedin')
  const review = await act(h, s.supabase, liReview(s.person))
  assert.deepEqual([review.state, review.reviewStatus], ['pending', 'restored'])
  assert.equal((await latest(s.person, 'linkedin')).id, previous.id)
  assert.equal((await latest(s.person, 'linkedin')).remote_account, '616')
  assert.equal(calls.filter(c => c === 'POST /li_account/Connect').length, 1)
  assert.equal(calls.some(c => c.startsWith('DELETE')), false)
})

test('failed and expired LinkedIn attempts never remove an external account implicitly', async t => {
  let shared: { workspace: string; linkedinWorkspace: string } | undefined
  for (const state of ['failed', 'expired'] as const) {
    const s = await person(t, shared); shared = s
    const calls: string[] = []
    const h = handlers([senders([]), connect(json({ linkedInAccountId: state === 'failed' ? 604 : 606 })), liStatus(li(604, 'Disconnected')),
      getById(json({ id: 604, activeCampaigns: 0 })), remove(json({}))], calls)
    await act(h, s.supabase, password(s.person, s.email))
    if (state === 'expired') await windowPassed(s.person, 'linkedin')
    await pollReady(s.person, 'linkedin')
    assert.equal((await act(h, s.supabase, liPoll(s.person))).state, state)
    await cooledDown(s.person, 'linkedin')
    await act(handlers([senders([]), connect(json({ linkedInAccountId: 607 }))], calls), s.supabase, password(s.person, s.email))
    assert.ok(!calls.some(call => call.startsWith('DELETE')))
  }
})

test('recovery cannot adopt an account after its provider workspace changes', async t => {
  const s = await person(t); const calls: string[] = []
  await act(handlers([senders([]), connect(down)]), s.supabase, password(s.person, s.email))
  await pollReady(s.person, 'linkedin')
  const binding = await admin.from('outreach_reply_workspaces').select('version').eq('client_id', s.client.id).eq('channel', 'linkedin').single()
  assert.ifError(binding.error)
  assert.ifError((await admin.from('outreach_reply_workspaces').update({ version: binding.data!.version + 1 }).eq('client_id', s.client.id).eq('channel', 'linkedin')).error)
  assert.equal((await act(handlers([senders([{ id: 608, emailAddress: s.email }])], calls), s.supabase, liReview(s.person))).http, 403)
  assert.deepEqual(calls, [])
})

test('only someone who may connect this person can check or switch their attempts', async t => {
  const s = await person(t); const outsider = await createTenant(t, { features: ['outreach_app'] })
  await act(handlers([senders([]), connect(down)]), s.supabase, password(s.person, s.email))
  assert.equal((await outsider.supabase.rpc('prepare_outreach_linkedin_review', { p_person: s.person })).error?.code, '42501')
  assert.equal((await outsider.supabase.rpc('prepare_outreach_email_switch', { p_person: s.person })).error?.code, '42501')
  for (const name of ['read_outreach_linkedin_review', 'finish_outreach_linkedin_review', 'finish_outreach_email_switch'] as const) {
    const args = name === 'read_outreach_linkedin_review' ? { p_id: randomUUID(), p_lease: randomUUID() } : { p_id: randomUUID(), p_lease: randomUUID(), p_outcome: 'missing' }
    assert.equal((await s.supabase.rpc(name, args as never)).error?.code, '42501', name)
  }
})

test('losing the very first email request is a normal failure, retryable after 30 seconds', async t => {
  const s = await person(t)
  const first = await act(handlers([[/^GET \/workspaces\/current$/, down]]), s.supabase, { action: 'start', personId: s.person, channel: 'email', provider: 'google' })
  assert.deepEqual([first.state, first.failureCode], ['failed', 'service_unavailable'])
  await cooledDown(s.person, 'email')
  assert.equal((await act(handlers([ws(s.workspace), init('google')]), s.supabase, { action: 'start', personId: s.person, channel: 'email', provider: 'google' })).state, 'pending')
})

test('switching provider while a sign-in is open checks the mailbox first and never loses an open sign-in', async t => {
  const s = await person(t)
  const start = (provider: string) => ({ action: 'start', personId: s.person, channel: 'email', provider })
  const change = (provider: string) => ({ action: 'switch', personId: s.person, channel: 'email', provider })
  let lookup: Handler = json({ message: 'Account not found' }, 404)
  const h = handlers([ws(s.workspace), init('google'), init('microsoft'), mailbox((url, init) => lookup(url, init))])
  const google = await act(h, s.supabase, start('google'))
  assert.equal(new URL(google.authUrl!).hostname, 'accounts.google.com')
  // A plain start still resumes the open sign-in; only the explicit switch replaces it.
  assert.equal((await act(h, s.supabase, start('microsoft'))).authUrl, google.authUrl)
  const tooSoon = await act(h, s.supabase, change('microsoft'))
  assert.deepEqual([tooSoon.http, tooSoon.failureCode], [400, 'connection_retry_later'])
  await cooledDown(s.person, 'email')
  lookup = () => Response.json({ message: 'unavailable' }, { status: 503 })
  const unchecked = await act(h, s.supabase, change('microsoft'))
  assert.deepEqual([unchecked.state, unchecked.authUrl, unchecked.failureCode], ['pending', null, 'service_unavailable'])
  const open = await admin.from('outreach_connections').select('state,auth_url,lease_id').eq('id', (await latest(s.person, 'email')).id).single()
  assert.deepEqual(open.data, { state: 'pending', auth_url: google.authUrl, lease_id: null })
  lookup = json({ message: 'Account not found' }, 404)
  const microsoft = await act(h, s.supabase, change('microsoft'))
  assert.equal(new URL(microsoft.authUrl!).hostname, 'login.microsoftonline.com')
  assert.equal((await act(h, s.supabase, change('microsoft'))).authUrl, microsoft.authUrl)

  const done = await person(t, s)
  const connected = handlers([ws(done.workspace), init('google'), init('microsoft'), mailbox(json({ email: done.email, organization: done.workspace, status: 1, setup_pending: false }))])
  await act(connected, done.supabase, { action: 'start', personId: done.person, channel: 'email', provider: 'google' })
  await cooledDown(done.person, 'email')
  const kept = await act(connected, done.supabase, { action: 'switch', personId: done.person, channel: 'email', provider: 'microsoft' })
  assert.equal(kept.state, 'connected')
})
