import assert from 'node:assert/strict'
import test from 'node:test'
import { connectAccount, reviewEmailAccount, checkConnectionWorkspace, verifyConnectionWorkspace, googleAuthorizationUrl, microsoftAuthorizationUrl, emailAuthorizationUrl, type ConnectionContext } from '../../src/lib/onboarding-provider'

const workspace = '00000000-0000-4000-8000-000000000001'
const sessionId = '00000000-0000-4000-8000-000000000002'
const context: ConnectionContext = { channel: 'email', email: 'person@example.test', workspace, credential: 'OUTREACH_INSTANTLY_TEST', remoteSession: sessionId, remoteAccount: null }
function transport(responses: (unknown | Response)[], check?: (url: string, init?: RequestInit) => void): typeof fetch {
  return async (url, init) => { check?.(String(url), init); assert.ok(responses.length, 'Unexpected provider request'); const response = responses.shift(); return response instanceof Response ? response : Response.json(response) }
}
/** HeyReach stub: answers the sender list on its own so connect tests script only connect responses. */
function heyreach(handler: typeof fetch, senders: { id: number; emailAddress?: string }[] = []): typeof fetch {
  return async (url, init) => String(url).endsWith('/li_account/GetAll') ? Response.json({ totalCount: senders.length, items: senders }) : handler(url, init)
}
test('Google initialization only accepts a Google authorization URL and verifies workspace first', async () => {
  const paths: string[] = []
  const result = await connectAccount(context, 'start', { key: 'synthetic', fetch: transport([{ id: workspace }, { session_id: sessionId, auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=test', expires_at: new Date(Date.now()+600000).toISOString() }], (url, init) => {
    paths.push(new URL(url).pathname); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal); assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic')
  }) })
  assert.equal(result.state, 'pending'); assert.equal(result.remoteSession, sessionId)
  assert.deepEqual(paths, ['/api/v2/workspaces/current', '/api/v2/oauth/google/init'])
  for (const url of ['https://accounts.google.com.evil.test/o/oauth2/auth?state=x', 'https://evil.test', 'javascript:alert(1)', 'https://accounts.google.com@evil.test', 'https://accounts.google.com/other?state=x']) assert.throws(() => googleAuthorizationUrl(url))
})
test('Microsoft initialization uses the Microsoft endpoint and only accepts a Microsoft authorization URL', async () => {
  const paths: string[] = []
  const authUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=synthetic&state=test'
  const result = await connectAccount(context, 'start', { key: 'synthetic', fetch: transport([{ id: workspace }, { session_id: sessionId, auth_url: authUrl, expires_at: new Date(Date.now()+600000).toISOString() }], url => {
    paths.push(new URL(url).pathname)
  }) }, { provider: 'microsoft' })
  assert.deepEqual(result, { state: 'pending', remoteSession: sessionId, authUrl })
  assert.deepEqual(paths, ['/api/v2/workspaces/current', '/api/v2/oauth/microsoft/init'])
  for (const url of ['https://login.microsoftonline.com.evil.test/common/oauth2/v2.0/authorize?state=x', 'https://evil.test/common/oauth2/v2.0/authorize?state=x',
    'https://login.microsoftonline.com@evil.test/common/oauth2/v2.0/authorize?state=x', 'http://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=x',
    'https://login.microsoftonline.com/common/oauth2/v2.0/token?state=x', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize']) assert.throws(() => microsoftAuthorizationUrl(url))
})
test('a sign-in link from the other provider is never handed to the person', async () => {
  const google = 'https://accounts.google.com/o/oauth2/v2/auth?state=test'
  const result = await connectAccount(context, 'start', { key: 'synthetic', fetch: transport([{ id: workspace }, { session_id: sessionId, auth_url: google, expires_at: new Date(Date.now()+600000).toISOString() }]) }, { provider: 'microsoft' })
  assert.equal(result.state, 'uncertain'); assert.equal('authUrl' in result ? result.authUrl : undefined, undefined)
})
test('saved sign-in links are accepted from Google or Microsoft only', () => {
  for (const url of ['https://accounts.google.com/o/oauth2/v2/auth?state=a', 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?state=a']) assert.equal(emailAuthorizationUrl(url), url)
  for (const url of ['https://evil.test/?state=a', 'https://accounts.google.com.evil.test/o/oauth2/auth?state=a']) assert.throws(() => emailAuthorizationUrl(url))
})
test('wrong workspace prevents OAuth initialization', async () => {
  assert.deepEqual(await connectAccount(context, 'start', { key: 'synthetic', fetch: transport([{ id: sessionId }]) }), { state: 'failed', failureCode: 'workspace_mismatch' })
})
test('Google success is bound to the expected mailbox and account workspace', async () => {
  assert.deepEqual(await connectAccount(context, 'poll', { key: 'synthetic', fetch: transport([{ id: workspace }, { status: 'success', email: context.email, account_id: context.email }, { email: context.email, organization: workspace, status: 1, setup_pending: false }]) }), { state: 'connected', remoteAccount: context.email })
  assert.deepEqual(await connectAccount(context, 'poll', { key: 'synthetic', fetch: transport([{ id: workspace }, { status: 'success', email: 'other@example.test', account_id: 'other@example.test' }]) }), { state: 'failed', failureCode: 'mailbox_mismatch' })
})
test('timeouts and unrecognized consumed OAuth results remain uncertain with no automatic retry', async () => {
  let calls = 0
  const result = await connectAccount(context, 'start', { key: 'synthetic', fetch: async () => { calls++; throw new Error('Do not expose credential diagnostics') } })
  assert.deepEqual(result, { state: 'uncertain', failureCode: 'service_unavailable' }); assert.equal(calls, 1)
  assert.deepEqual(await connectAccount(context, 'poll', { key: 'synthetic', fetch: transport([{ id: workspace }, { status: 'unexpected', password: 'sensitive' }]) }), { state: 'uncertain', failureCode: 'service_unavailable' })
})
test('HeyReach Connect uses scoped transport and never requests personal inbox scraping', async () => {
  const result = await connectAccount({ ...context, channel: 'linkedin' }, 'start', { key: 'synthetic', fetch: heyreach(transport([{ linkedInAccountId: 123 }], (url, init) => {
    assert.equal(url, 'https://api.heyreach.io/api/public/li_account/Connect')
    assert.equal(new Headers(init?.headers).get('X-API-KEY'), 'synthetic')
    assert.deepEqual(JSON.parse(String(init?.body)), { username: context.email, password: 'fake-password', twoFactorAuthKey: '', proxyCountryCode: 'us', inboxScrapeMode: 'HeyReachOnly' })
  })) }, { password: 'fake-password', country: 'US' })
  assert.deepEqual(result, { state: 'pending', remoteAccount: '123', nextStep: 'connecting' }); assert.ok(!JSON.stringify(result).includes('fake-password'))
})
test('HeyReach PIN and status are bound to the saved account; unknown intermediate states stay pending', async () => {
  const scope = { ...context, channel: 'linkedin' as const, remoteAccount: '123' }
  assert.deepEqual(await connectAccount(scope, 'pin', { key: 'synthetic', fetch: transport([{ accountId: 123, status: 'PinRequired', profile: { profileUrl: null } }, new Response(null, { status: 204 })], (url, init) => { if (url.endsWith('/SubmitPin')) assert.deepEqual(JSON.parse(String(init?.body)), { accountId: 123, pin: '123456' }) }) }, { pin: '123456' }), { state: 'pending', nextStep: 'connecting' })
  assert.deepEqual(await connectAccount(scope, 'poll', { key: 'synthetic', fetch: transport([{ accountId: 123, status: 'AwaitingVerification' }]) }), { state: 'pending', nextStep: 'check_status' })
  assert.deepEqual(await connectAccount(scope, 'poll', { key: 'synthetic', fetch: transport([{ accountId: 456, status: 'Connected' }]) }), { state: 'failed' })
  assert.deepEqual(await connectAccount(scope, 'poll', { key: 'synthetic', fetch: transport([{ accountId: 123, status: 'Connected', profile: { profileUrl: 'https://www.linkedin.com/in/person' } }]) }), { state: 'connected', remoteAccount: '123', address: 'https://www.linkedin.com/in/person' })
})
test('HeyReach credential check accepts both documented success statuses without requiring JSON', async () => {
  for (const response of [new Response(null, { status: 204 }), new Response(null, { status: 200 }), new Response('API key valid', { status: 200 })]) {
    assert.equal(await checkConnectionWorkspace('linkedin', 'workspace', { key: 'synthetic', fetch: transport([response]) }), true)
  }
})
test('HeyReach credential check rejects errors and unexpected statuses without leaking diagnostics', async (t) => {
  const warning = t.mock.method(console, 'warn', () => {})
  for (const status of [202, 301, 401, 403, 429, 500]) {
    assert.equal(await checkConnectionWorkspace('linkedin', 'workspace', { key: 'synthetic-private-key', fetch: transport([new Response('private provider body', { status })]) }), false)
  }
  assert.equal(await checkConnectionWorkspace('linkedin', 'workspace', { key: 'synthetic-private-key', fetch: async () => { throw new Error('private transport details') } }), false)
  const logs = JSON.stringify(warning.mock.calls.map(call => call.arguments))
  assert.ok(logs.includes('401'))
  for (const secret of ['synthetic-private-key', 'private provider body', 'private transport details']) assert.ok(!logs.includes(secret))
})
test('verification classifies rejected keys, denied access, rate limits and service failures', async (t) => {
  t.mock.method(console, 'warn', () => {})
  for (const [status, code] of [[401, 'key_rejected'], [403, 'provider_access_denied'], [429, 'provider_rate_limited'], [503, 'provider_unavailable'], [202, 'key_verification_failed']] as const) {
    assert.deepEqual(await verifyConnectionWorkspace('linkedin', 'workspace', { key: 'synthetic', fetch: transport([new Response('private error', { status })]) }), { ok: false, code })
  }
})

test('Google permission errors become fixed codes without exposing credentials or service text', async (t) => {
  const log = t.mock.method(console, 'warn', () => {})
  for (const [status, message, code] of [
    [401, 'Invalid scope. Required: accounts:create. Found: accounts:read', 'account_create_required'],
    [403, 'Invalid scope. Required: accounts:read. Found: accounts:create', 'account_read_required'],
    [401, 'secret-token-rejected', 'key_rejected'],
    [403, 'private-error', 'access_denied'],
    [429, 'private-error', 'rate_limited'],
    [503, 'private-error', 'service_unavailable'],
  ] as const) {
    const calls: string[] = []
    const result = await connectAccount(context, 'start', { key: 'secret-key', fetch: transport([{ id: workspace }, Response.json({ message }, { status })], url => calls.push(url)) })
    assert.equal(result.failureCode, code)
    assert.equal(result.state, status === 503 ? 'uncertain' : 'failed')
    assert.equal(calls.length, 2)
    assert.equal(result.authUrl, undefined)
  }
  const logs = JSON.stringify(log.mock.calls.map(call => call.arguments))
  assert.ok(logs.includes('google_start'))
  for (const secret of ['secret-key', 'secret-token-rejected', 'private-error', context.email, workspace]) assert.ok(!logs.includes(secret))
})

test('unreadable OAuth completion is reconciled from the exact active mailbox without replaying consent', async (t) => {
  const log = t.mock.method(console, 'warn', () => {})
  for (const completion of [
    { status: 'success', email: context.email },
    { status: 'success', email: context.email, account_id: sessionId },
    { status: 'unexpected' },
    Response.json({ error: 'private diagnostic' }, { status: 502 }),
    Response.json({ error: 'session no longer available' }, { status: 404 }),
  ]) {
    const paths: string[] = []
    const result = await connectAccount(context, 'poll', { key: 'secret-key', fetch: transport([
      { id: workspace }, completion, { email: context.email, organization: workspace, status: 1, setup_pending: false },
    ], url => paths.push(new URL(url).pathname)) })
    assert.deepEqual(result, { state: 'connected', remoteAccount: context.email })
    assert.deepEqual(paths, ['/api/v2/workspaces/current', `/api/v2/oauth/session/status/${sessionId}`, `/api/v2/accounts/${encodeURIComponent(context.email)}`])
  }
  const logs = JSON.stringify(log.mock.calls.map(call => call.arguments))
  for (const secret of ['secret-key', 'private diagnostic', context.email, workspace, sessionId]) assert.ok(!logs.includes(secret))
})

test('reconciliation preserves review for missing, wrong-workspace, wrong-mailbox, inactive or unready accounts', async (t) => {
  t.mock.method(console, 'warn', () => {})
  for (const account of [
    Response.json({}, { status: 404 }),
    Response.json({}, { status: 503 }),
    { email: context.email, organization: sessionId, status: 1 },
    { email: 'someone-else@example.test', organization: workspace, status: 1 },
    { email: context.email, organization: workspace, status: 2 },
    { email: context.email, organization: workspace, status: 1, setup_pending: true },
    { email: context.email, status: 1 },
  ]) {
    let calls = 0
    assert.deepEqual(await connectAccount(context, 'poll', { key: 'synthetic', fetch: transport([
      { id: workspace }, { status: 'unexpected' }, account,
    ], () => { calls++ }) }), { state: 'uncertain', failureCode: 'service_unavailable' })
    assert.equal(calls, 3)
  }
})

test('explicit OAuth identity mismatch is never reconciled even with incomplete success fields', async () => {
  for (const result of [
    { status: 'success', email: 'other@example.test' },
    { status: 'success', email: 'other@example.test', account_id: sessionId },
    { status: 'success', email: 'other@example.test', account_id: null },
    { status: 'success', email: context.email, account_id: 'other@example.test' },
  ]) {
    let calls = 0
    assert.deepEqual(await connectAccount(context, 'poll', { key: 'synthetic', fetch: transport([{ id: workspace }, result], () => { calls++ }) }),
      { state: 'failed', failureCode: 'mailbox_mismatch' })
    assert.equal(calls, 2)
  }
})

test('known OAuth failures and expired sessions retain their state without account reconciliation', async (t) => {
  t.mock.method(console, 'warn', () => {})
  for (const [response, state] of [[{ status: 'error' }, 'failed'], [{ status: 'expired' }, 'expired'], [{ status: 'pending' }, 'pending'], [Response.json({}, { status: 403 }), 'failed']] as const) {
    let calls = 0
    const result = await connectAccount(context, 'poll', { key: 'synthetic', fetch: transport([{ id: workspace }, response], () => { calls++ }) })
    assert.equal(result.state, state)
    assert.equal(calls, 2)
  }
})

test('explicit review only reads workspace and reserved mailbox; missing differs from service errors', async () => {
  for (const [response, outcome] of [
    [{ email: context.email, organization: workspace, status: 1, setup_pending: false }, 'connected'],
    [Response.json({}, { status: 404 }), 'missing'],
    [Response.json({}, { status: 503 }), 'unavailable'],
    [{ email: 'wrong@example.test', organization: workspace, status: 1 }, 'unavailable'],
    [{ email: context.email, organization: sessionId, status: 1 }, 'unavailable'],
    [{ email: context.email, organization: workspace, status: 1, setup_pending: true }, 'unavailable'],
  ] as const) {
    const paths: string[] = []
    const result = await reviewEmailAccount(context, { key: 'synthetic', fetch: transport([{ id: workspace }, response], (url, init) => {
      assert.equal(init?.method, 'GET'); paths.push(new URL(url).pathname)
    }) })
    assert.equal(result.outcome, outcome)
    assert.deepEqual(paths, ['/api/v2/workspaces/current', `/api/v2/accounts/${encodeURIComponent(context.email)}`])
  }
  assert.equal((await reviewEmailAccount(context, { key: 'synthetic', fetch: transport([Response.json({}, { status: 404 })]) })).outcome, 'unavailable')
  assert.deepEqual(await reviewEmailAccount(context, { key: 'synthetic', fetch: transport([{ id: sessionId }]) }), { outcome: 'unavailable', failureCode: 'workspace_mismatch' })
})

test('personal Gmail never initializes OAuth, even when Microsoft was selected', async () => {
  for (const provider of ['google', 'microsoft'] as const) for (const address of ['person@gmail.com', 'person@googlemail.com']) {
    let calls = 0
    const result = await connectAccount({ ...context, email: address }, 'start', { key: 'synthetic', fetch: async () => { calls++; throw new Error('Must not call provider') } }, { provider })
    assert.deepEqual(result, { state: 'failed', failureCode: 'personal_gmail_unsupported' }); assert.equal(calls, 0)
  }
})
test('terminal OAuth errors provide fixed codes without exposing arbitrary service text', async () => {
  for (const [error, failureCode] of [['account_exists', 'account_already_assigned'], ['access_denied', 'consent_denied'], ['private service error', 'sign_in_rejected']] as const) {
    assert.deepEqual(await connectAccount(context, 'poll', { key: 'synthetic', fetch: transport([{ id: workspace }, { status: 'error', error, error_description: 'sensitive details' }]) }), { state: 'failed', failureCode })
  }
})

test('cookie connection sends only a validated session and records no cookie values in the result', async () => {
  const cookies = [{name:'li_at' as const,value:'synthetic-session',domain:'.linkedin.com' as const,path:'/' as const}, {name:'JSESSIONID' as const,value:'"ajax:synthetic"',domain:'.linkedin.com' as const,path:'/' as const}]
  const scope = {...context,channel:'linkedin' as const,expectedProfileUrl:'https://www.linkedin.com/in/test-person'}
  const result = await connectAccount(scope,'start',{key:'synthetic',fetch:transport([{linkedInAccountId:321}],(url,init)=>{
    assert.equal(url,'https://api.heyreach.io/api/public/li_account/ConnectWithCookies')
    assert.deepEqual(JSON.parse(String(init?.body)),{cookies,proxyCountryCode:'us',inboxScrapeMode:'HeyReachOnly',userAgent:'Synthetic Chrome'})
  })},{cookies,country:'US',userAgent:'Synthetic Chrome'})
  assert.deepEqual(result,{state:'pending',remoteAccount:'321',nextStep:'connecting'})
  for(const value of cookies.map(c=>c.value))assert.ok(!JSON.stringify(result).includes(value))
})

test('cookie polling verifies the expected profile and retains uncertainty on a lost start', async t => {
  const scope={...context,channel:'linkedin' as const,remoteAccount:'321',expectedProfileUrl:'https://www.linkedin.com/in/test-person'}
  for(const [profileUrl,matched] of [['https://linkedin.com/in/Test-Person/?trk=test',true],['https://www.linkedin.com/in/other-person',false]] as const){
    const result=await connectAccount(scope,'poll',{key:'synthetic',fetch:transport([{accountId:321,status:'Connected',profile:{profileUrl}}])})
    assert.deepEqual(result,matched?{state:'connected',remoteAccount:'321',address:scope.expectedProfileUrl}:{state:'failed',failureCode:'linkedin_profile_mismatch'})
  }
  const cookies=[{name:'li_at' as const,value:'synthetic-cookie-secret',domain:'.linkedin.com' as const,path:'/' as const},{name:'JSESSIONID' as const,value:'synthetic-other-secret',domain:'.linkedin.com' as const,path:'/' as const}]
  const log=t.mock.method(console,'warn',()=>{})
  for(const [status,expected] of [[403,{state:'failed',failureCode:'linkedin_access_denied'}],[400,{state:'failed',failureCode:'linkedin_request_rejected'}],[502,{state:'uncertain'}]] as const){
    assert.deepEqual(await connectAccount(scope,'start',{key:'synthetic',fetch:heyreach(transport([new Response('synthetic-cookie-secret',{status})]))},{cookies,country:'US',userAgent:'Synthetic Chrome'}),expected)
  }
  let calls=0
  assert.deepEqual(await connectAccount(scope,'start',{key:'synthetic',fetch:heyreach(async()=>{calls++;throw Error('synthetic-cookie-secret')})},{cookies,country:'US',userAgent:'Synthetic Chrome'}),{state:'uncertain'})
  assert.equal(calls,1);assert.ok(!JSON.stringify(log.mock.calls).includes('synthetic-cookie-secret'))
})

test('LinkedIn failure diagnostics contain fixed metadata without request or response secrets', async t => {
  const log=t.mock.method(console,'warn',()=>{})
  const scope={...context,channel:'linkedin' as const,expectedProfileUrl:'https://www.linkedin.com/in/synthetic'}
  const cookies=[{name:'li_at' as const,value:'private-cookie',domain:'.linkedin.com' as const,path:'/' as const},{name:'JSESSIONID' as const,value:'private-session',domain:'.linkedin.com' as const,path:'/' as const}]
  const result=await connectAccount(scope,'start',{key:'private-key',fetch:heyreach(transport([new Response('private-response',{status:403})]))},{cookies,country:'US',userAgent:'private-user-agent'})
  assert.equal(result.failureCode,'linkedin_access_denied')
  const logs=JSON.stringify(log.mock.calls.map(call=>call.arguments))
  assert.match(logs,/403/); assert.match(logs,/cookies/)
  for(const secret of ['private-cookie','private-session','private-key','private-response','private-user-agent',context.email])assert.ok(!logs.includes(secret))
})

test('LinkedIn country codes match the live country catalog format for both sign-in methods', async () => {
  const scope={...context,channel:'linkedin' as const,expectedProfileUrl:'https://www.linkedin.com/in/synthetic'}
  const cookies=[{name:'li_at' as const,value:'synthetic-session',domain:'.linkedin.com' as const,path:'/' as const},{name:'JSESSIONID' as const,value:'synthetic-csrf',domain:'.linkedin.com' as const,path:'/' as const}]
  for(const method of ['cookies','password'])for(const country of ['US','IN','GB']){
    const result=await connectAccount(scope,'start',{key:'synthetic',fetch:transport([{linkedInAccountId:87}],(_url,init)=>{
      const body=JSON.parse(String(init?.body));assert.equal(body.proxyCountryCode,country.toLowerCase());assert.equal(body.customProxy,undefined)
    })},{country,...(method==='cookies'?{cookies,userAgent:'Synthetic Chrome'}:{password:'synthetic-password'})})
    assert.equal(result.state,'pending')
  }
})

test('LinkedIn 400/422 separates location errors, expired sessions and unknown rejections without leaking text', async t => {
  const log=t.mock.method(console,'warn',()=>{}),scope={...context,channel:'linkedin' as const,expectedProfileUrl:'https://www.linkedin.com/in/synthetic'}
  const cookies=[{name:'li_at' as const,value:'private-cookie',domain:'.linkedin.com' as const,path:'/' as const},{name:'JSESSIONID' as const,value:'private-session',domain:'.linkedin.com' as const,path:'/' as const}]
  const cases: [string,string][]=[
    ['No proxy available for this country: private-detail','linkedin_location_unavailable'],
    [JSON.stringify({message:'Proxy country unavailable',request:{cookies:'private-cookie'}}),'linkedin_location_unavailable'],
    [JSON.stringify({errors:{ProxyCountryCode:['Unsupported private-detail']}}),'linkedin_location_unavailable'],
    ['Session cookies have expired: private-cookie','linkedin_session_rejected'],
    [JSON.stringify({errorMessage:'Invalid cookies: private-cookie'}),'linkedin_session_rejected'],
    [JSON.stringify({message:'Unknown rejection',request:{proxyCountryCode:'US'}}),'linkedin_request_rejected'],
    ['private-cookie','linkedin_request_rejected'],
    ['', 'linkedin_request_rejected'],
    ['x'.repeat(16385), 'linkedin_request_rejected'],
  ]
  for(const status of [400,422])for(const [body,failureCode] of cases){
    let calls=0
    const result=await connectAccount(scope,'start',{key:'private-key',fetch:heyreach(async()=>{calls++;return new Response(body,{status})})},{cookies,country:'US',userAgent:'Synthetic Chrome'})
    assert.deepEqual(result,{state:'failed',failureCode});assert.equal(calls,1)
  }
  const logs=JSON.stringify(log.mock.calls.map(call=>call.arguments));for(const secret of ['private-cookie','private-session','private-key','private-detail',context.email])assert.ok(!logs.includes(secret))
})

test('a lost connect reply adopts the single sender it created; a browser session is still verified on poll', async () => {
  const scope = { ...context, channel: 'linkedin' as const, expectedProfileUrl: 'https://www.linkedin.com/in/test-person' }
  const cookies = [{ name: 'li_at' as const, value: 'synthetic-session', domain: '.linkedin.com' as const, path: '/' as const }, { name: 'JSESSIONID' as const, value: '"ajax:1"', domain: '.linkedin.com' as const, path: '/' as const }]
  const senders = [{ id: 11 }]
  const lost = heyreach(async () => { senders.push({ id: 12 }); throw new DOMException('The operation timed out.', 'TimeoutError') }, senders)
  assert.deepEqual(await connectAccount(scope, 'start', { key: 'synthetic', fetch: lost }, { cookies, country: 'US', userAgent: 'Synthetic Chrome' }), { state: 'pending', remoteAccount: '12', nextStep: 'connecting' })
  // The adopted sender must still prove the expected profile before it can count as connected.
  const polled = await connectAccount({ ...scope, remoteAccount: '12' }, 'poll', { key: 'synthetic', fetch: transport([{ accountId: 12, status: 'Connected', profile: { profileUrl: 'https://www.linkedin.com/in/someone-else' } }]) })
  assert.deepEqual(polled, { state: 'failed', failureCode: 'linkedin_profile_mismatch' })
})

test('a lost password login is adopted only for the sender carrying that login, never on ambiguity', async () => {
  const scope = { ...context, channel: 'linkedin' as const }
  const attempt = async (created: { id: number; emailAddress?: string }[], start: { id: number; emailAddress?: string }[] = [{ id: 1, emailAddress: 'other@example.test' }]) => {
    const senders = [...start]
    return connectAccount(scope, 'start', { key: 'synthetic', fetch: heyreach(async () => { senders.push(...created); throw new TypeError('fetch failed') }, senders) }, { password: 'fake-password', country: 'US' })
  }
  assert.deepEqual(await attempt([{ id: 2, emailAddress: context.email.toUpperCase() }]), { state: 'pending', remoteAccount: '2', nextStep: 'connecting' })
  assert.deepEqual(await attempt([{ id: 2, emailAddress: 'someone@example.test' }]), { state: 'uncertain' })
  assert.deepEqual(await attempt([{ id: 2 }]), { state: 'uncertain' })
  assert.deepEqual(await attempt([{ id: 2, emailAddress: context.email }, { id: 3, emailAddress: context.email }]), { state: 'uncertain' })
  assert.deepEqual(await attempt([]), { state: 'uncertain' })
})

test('no recovery without a complete sender list, and never after a definite rejection', async () => {
  const scope = { ...context, channel: 'linkedin' as const }
  let lists = 0
  const unavailable: typeof fetch = async url => { if (String(url).endsWith('/li_account/GetAll')) { lists++; return new Response('down', { status: 503 }) } throw new TypeError('fetch failed') }
  assert.deepEqual(await connectAccount(scope, 'start', { key: 'synthetic', fetch: unavailable }, { password: 'fake-password', country: 'US' }), { state: 'uncertain' })
  assert.equal(lists, 1)
  const partial: typeof fetch = async url => String(url).endsWith('/li_account/GetAll') ? Response.json({ totalCount: 150, items: [{ id: 1 }] }) : (() => { throw new TypeError('fetch failed') })()
  assert.deepEqual(await connectAccount(scope, 'start', { key: 'synthetic', fetch: partial }, { password: 'fake-password', country: 'US' }), { state: 'uncertain' })
  lists = 0
  const rejected: typeof fetch = async url => { if (String(url).endsWith('/li_account/GetAll')) { lists++; return Response.json({ totalCount: 0, items: [] }) } return new Response('{"errorMessage":"nope"}', { status: 403 }) }
  assert.deepEqual(await connectAccount(scope, 'start', { key: 'synthetic', fetch: rejected }, { password: 'fake-password', country: 'US' }), { state: 'failed', failureCode: 'linkedin_access_denied' })
  assert.equal(lists, 1)
})

test('a workspace without a free sender seat gets its own failure code', async () => {
  const seat = heyreach(transport([new Response(JSON.stringify({ errorMessage: 'You cannot connect a LinkedIn Sender without a free seat. Purchase additional seats, or disconnect an existing sender.' }), { status: 403 })]))
  assert.deepEqual(await connectAccount({ ...context, channel: 'linkedin' }, 'start', { key: 'synthetic', fetch: seat }, { password: 'fake-password', country: 'US' }), { state: 'failed', failureCode: 'linkedin_no_free_seat' })
})
