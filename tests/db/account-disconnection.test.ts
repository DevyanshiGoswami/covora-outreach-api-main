import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { adminClient } from '../helpers/admin'
import { createTenant, createAdmin } from '../helpers/tenants'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach'
import { createOnboardingHandlers } from '../../src/lib/onboarding-api'
import { loadTestEnv } from '../helpers/env'
const admin=adminClient()
async function fixture(t: Parameters<typeof createTenant>[0]) {
  const tenant=await createTenant(t,{features:['outreach_app']}), member=await createAdmin(t)
  await grantOutreachMembership(tenant.user.id,tenant.client.id)
  await grantOutreachMembership(member.user.id,tenant.client.id,'client_member')
  const workspace=randomUUID(),credential=`OUTREACH_INSTANTLY_${randomUUID().replaceAll('-','').toUpperCase()}`
  assert.ifError((await admin.from('outreach_account_workspaces').insert({client_id:tenant.client.id,remote_workspace_id:workspace,credential_ref:credential,enabled:true})).error)
  assert.ifError((await admin.from('outreach_reply_workspaces').insert({client_id:tenant.client.id,channel:'linkedin',remote_workspace_id:randomUUID(),credential_ref:`OUTREACH_HEYREACH_${randomUUID().replaceAll('-','').toUpperCase()}`,enabled:true})).error)
  const listed=await member.supabase.rpc('list_outreach_people',{p_client:tenant.client.id});assert.ifError(listed.error)
  const person=(listed.data as {id:string}[])[0]
  async function connect(channel='email',address=member.user.email) {
    const claim=await member.supabase.rpc('prepare_outreach_connection',{p_person:person.id,p_channel:channel,p_action:'start',p_email:address});assert.ifError(claim.error)
    const c=claim.data![0],remote=channel==='email'?address:String(Math.floor(Math.random()*1e12)+1)
    if(channel==='linkedin')assert.ifError((await admin.from('outreach_connections').update({remote_account:remote}).eq('id',c.connection_id)).error)
    const done=await admin.rpc('finish_outreach_connection',{p_id:c.connection_id,p_lease:c.claim_token!,p_state:'connected',p_remote_account:remote,...(channel==='linkedin'?{p_address:'https://www.linkedin.com/in/test-person'}:{})});assert.ifError(done.error);assert.equal(done.data,true)
    return c.connection_id
  }
  return {tenant,member,person,workspace,credential,connect}
}
test('members disconnect themselves; client admins and owners may disconnect client accounts; other roles and tenants are denied',async t=>{
  const f=await fixture(t),id=await f.connect(),other=await createTenant(t,{features:['outreach_app']}),viewer=await createAdmin(t),operator=await createAdmin(t),peer=await createAdmin(t),owner=await createAdmin(t)
  for(const [u,role] of [[viewer,'client_viewer'],[operator,'operator'],[peer,'client_member']] as const)await grantOutreachMembership(u.user.id,f.tenant.client.id,role)
  await grantOutreachOwner(owner.user.id)
  for(const actor of [viewer,operator,peer,other])assert.equal((await actor.supabase.rpc('prepare_outreach_disconnect',{p_connection:id,p_action:'disconnect'})).error?.code,'42501')
  for(const actor of [f.member,f.tenant,owner]) {
    const claim=await actor.supabase.rpc('prepare_outreach_disconnect',{p_connection:id,p_action:'disconnect'});assert.ifError(claim.error);assert.equal(claim.data![0].perform_delete,true)
    assert.equal((await admin.rpc('finish_outreach_disconnect',{p_id:id,p_lease:claim.data![0].claim_token!,p_outcome:'rejected'})).data,true)
  }
})
test('both channels release reservations only after removal and preserve people and other connections',async t=>{
  const f=await fixture(t),email=await f.connect(),linkedin=await f.connect('linkedin')
  for(const id of [email,linkedin]) {
    const claim=await f.member.supabase.rpc('prepare_outreach_disconnect',{p_connection:id,p_action:'disconnect'});assert.ifError(claim.error)
    const duplicate=await f.tenant.supabase.rpc('prepare_outreach_disconnect',{p_connection:id,p_action:'disconnect'});assert.ifError(duplicate.error);assert.equal(duplicate.data![0].claim_token,null)
    const state=(await admin.from('outreach_connections').select('channel').eq('id',id).single()).data!
    assert.equal((await f.member.supabase.rpc('prepare_outreach_connection',{p_person:f.person.id,p_channel:state.channel,p_action:'start'})).error?.code,'22023')
    assert.equal((await admin.rpc('finish_outreach_disconnect',{p_id:id,p_lease:claim.data![0].claim_token!,p_outcome:'removed'})).data,true)
    assert.equal((await admin.from('outreach_connection_reservations').select('email').eq('person_id',f.person.id).eq('channel',state.channel)).data?.length,0)
  }
  assert.ok((await admin.from('outreach_people').select('id').eq('id',f.person.id).single()).data)
  const replacement=`replacement-${randomUUID()}@example.test`
  const next=await f.connect('email',replacement)
  assert.equal((await admin.from('outreach_connections').select('expected_email').eq('id',next).single()).data?.expected_email,replacement)
  assert.equal((await admin.rpc('read_outreach_connection',{p_id:email,p_lease:randomUUID()})).data,null)
  assert.equal((await f.member.supabase.rpc('prepare_outreach_disconnect',{p_connection:email,p_action:'disconnect'})).data?.[0].perform_delete,false)
})
test('unknown deletion is never replayed, including crashes and role changes',async t=>{
  const f=await fixture(t),id=await f.connect()
  const first=await f.member.supabase.rpc('prepare_outreach_disconnect',{p_connection:id,p_action:'disconnect'});assert.ifError(first.error)
  assert.ifError((await admin.from('outreach_connections').update({lease_until:new Date(0).toISOString()}).eq('id',id)).error)
  const retry=await f.tenant.supabase.rpc('prepare_outreach_disconnect',{p_connection:id,p_action:'disconnect'});assert.ifError(retry.error);assert.equal(retry.data![0].perform_delete,false)
  assert.equal((await admin.rpc('finish_outreach_disconnect',{p_id:id,p_lease:first.data![0].claim_token!,p_outcome:'removed'})).data,false)
  await grantOutreachMembership(f.tenant.user.id,f.tenant.client.id,'client_viewer')
  assert.equal((await admin.rpc('finish_outreach_disconnect',{p_id:id,p_lease:retry.data![0].claim_token!,p_outcome:'removed'})).data,false)
  assert.equal((await admin.from('outreach_connection_reservations').select('email').eq('person_id',f.person.id)).data?.length,1)
})
test('the bearer API authorizes before calling the provider and verifies removal without exposing provider IDs',async t=>{
  const f=await fixture(t),id=await f.connect(),env=loadTestEnv(),other=await createAdmin(t)
  let removed=false,deletes=0
  const handlers=createOnboardingHandlers({url:env.URL,anonKey:env.ANON,serviceKey:env.SERVICE,fetch,credentials:{[f.credential]:'synthetic'},providerFetch:async(input,init)=>{
    const path=new URL(String(input)).pathname
    if(path.endsWith('/workspaces/current'))return Response.json({id:f.workspace})
    if(path.includes('/account-campaign-mappings/'))return Response.json({items:[]})
    if(init?.method==='DELETE'){deletes++;removed=true;return new Response(null,{status:204})}
    return removed?Response.json({},{status:404}):Response.json({email:f.member.user.email,organization:f.workspace,is_managed_account:false})
  }})
  async function send(actor:typeof f.member){const token=(await actor.supabase.auth.getSession()).data.session!.access_token;return handlers.connection(new Request('http://localhost/api/onboarding/connections',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({action:'disconnect',connectionId:id})}))}
  assert.equal((await send(other)).status,403);assert.equal(deletes,0)
  const result=await send(f.member);assert.equal(result.status,200);assert.equal((await result.json()).state,'disconnected');assert.equal(deletes,1)
  assert.equal((await send(f.member)).status,200);assert.equal(deletes,1)
})

test('preview workspaces reject removal and disconnecting senders cannot be re-enabled',async t=>{
  const f=await fixture(t),id=await f.connect('linkedin')
  const sender=(await admin.from('outreach_reply_senders').select('id').eq('client_id',f.tenant.client.id).single()).data!
  assert.ifError((await admin.from('outreach_reply_senders').update({enabled:true}).eq('id',sender.id)).error)
  assert.ifError((await admin.from('client_features').update({config:{presentation_mode:'preview'}}).eq('client_id',f.tenant.client.id).eq('feature','outreach_app')).error)
  assert.equal((await f.member.supabase.rpc('prepare_outreach_disconnect',{p_connection:id,p_action:'disconnect'})).error?.code,'42501')
  assert.ifError((await admin.from('client_features').update({config:{}}).eq('client_id',f.tenant.client.id).eq('feature','outreach_app')).error)
  const claim=await f.member.supabase.rpc('prepare_outreach_disconnect',{p_connection:id,p_action:'disconnect'});assert.ifError(claim.error)
  assert.equal((await admin.from('outreach_reply_senders').select('enabled').eq('id',sender.id).single()).data?.enabled,false)
  assert.equal((await admin.from('outreach_reply_senders').update({enabled:true}).eq('id',sender.id)).error?.code,'22023')
  assert.equal((await admin.rpc('finish_outreach_disconnect',{p_id:id,p_lease:claim.data![0].claim_token!,p_outcome:'removed'})).data,true)
  assert.equal((await admin.from('outreach_reply_senders').update({enabled:true}).eq('id',sender.id)).error?.code,'22023')
})

test('LinkedIn disconnect reads only the saved profile for the leased sender and workspace', async t => {
  const f = await fixture(t), id = await f.connect('linkedin')
  const claim = await f.member.supabase.rpc('prepare_outreach_disconnect', { p_connection: id, p_action: 'disconnect' })
  assert.ifError(claim.error)
  const lease = claim.data![0].claim_token!
  assert.equal((await f.member.supabase.rpc('read_outreach_disconnect', { p_id: id, p_lease: lease })).error?.code, '42501')
  assert.equal((await admin.rpc('read_outreach_disconnect', { p_id: id, p_lease: randomUUID() })).data, null)
  const read = await admin.rpc('read_outreach_disconnect', { p_id: id, p_lease: lease })
  assert.ifError(read.error)
  assert.equal((read.data as { verifiedProfileUrl: string }).verifiedProfileUrl, 'https://www.linkedin.com/in/test-person')
  // Changing the binding invalidates the whole claim, not just the profile.
  assert.ifError((await admin.from('outreach_reply_workspaces').update({ credential_ref: 'OUTREACH_HEYREACH_CHANGED' })
    .eq('client_id', f.tenant.client.id).eq('channel', 'linkedin')).error)
  assert.equal((await admin.rpc('read_outreach_disconnect', { p_id: id, p_lease: lease })).data, null)
})

test('LinkedIn disconnect API accepts a primary email alias only with the saved profile and identity', async t => {
  const f = await fixture(t), id = await f.connect('linkedin'), env = loadTestEnv(), other = await createAdmin(t)
  const connection = (await admin.from('outreach_connections').select('remote_account').eq('id', id).single()).data!
  const workspace = (await admin.from('outreach_reply_workspaces').select('credential_ref').eq('client_id', f.tenant.client.id).eq('channel', 'linkedin').single()).data!
  let removed = false, deletes = 0, calls = 0
  let profileUrl = 'https://www.linkedin.com/in/someone-else'
  const handlers = createOnboardingHandlers({ url: env.URL, anonKey: env.ANON, serviceKey: env.SERVICE, fetch,
    credentials: { [workspace.credential_ref]: 'synthetic' }, providerFetch: async (input, init) => {
      calls++
      const url = new URL(String(input))
      if (url.pathname.endsWith('/auth/CheckApiKey')) return new Response(null, { status: 204 })
      if (url.pathname.endsWith('/li_account/GetById')) {
        assert.equal(url.searchParams.get('accountId'), connection.remote_account)
        return removed ? Response.json({}, { status: 404 }) : Response.json({ id: Number(connection.remote_account),
          emailAddress: 'primary-alias@example.test', profileUrl, activeCampaigns: 0 })
      }
      assert.equal(url.pathname, '/api/public/li_account/RemoveAccount/' + connection.remote_account)
      assert.equal(url.search, '?force=false'); assert.equal(init?.method, 'DELETE')
      deletes++; removed = true; return new Response(null, { status: 204 })
    } })
  async function send(actor: typeof f.member) {
    const token = (await actor.supabase.auth.getSession()).data.session!.access_token
    return handlers.connection(new Request('http://localhost/api/onboarding/connections', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'disconnect', connectionId: id }) }))
  }
  assert.equal((await send(other)).status, 403); assert.equal(calls, 0)
  const mismatch = await send(f.member)
  assert.equal(mismatch.status, 200)
  assert.equal((await mismatch.json()).failureCode, 'disconnect_identity_mismatch'); assert.equal(deletes, 0)
  assert.equal((await admin.from('outreach_connection_reservations').select('email').eq('person_id', f.person.id)).data?.length, 1)
  profileUrl = 'https://linkedin.com/in/Test-Person/'
  const response = await send(f.member)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { connectionId: id, state: 'disconnected', authUrl: null })
  assert.equal(deletes, 1)
  assert.equal((await admin.from('outreach_connection_reservations').select('email').eq('person_id', f.person.id)).data?.length, 0)
  assert.equal((await send(f.member)).status, 200); assert.equal(deletes, 1)
})

test('a remote identity stays exclusive while removal is pending or uncertain',async t=>{
  const f=await fixture(t),id=await f.connect(),second=await createAdmin(t)
  await grantOutreachMembership(second.user.id,f.tenant.client.id,'client_member')
  const rows=await second.supabase.rpc('list_outreach_people',{p_client:f.tenant.client.id});assert.ifError(rows.error)
  const person=(rows.data as {id:string}[])[0]
  const secondClaim=await second.supabase.rpc('prepare_outreach_connection',{p_person:person.id,p_channel:'email',p_action:'start'});assert.ifError(secondClaim.error)
  const removal=await f.member.supabase.rpc('prepare_outreach_disconnect',{p_connection:id,p_action:'disconnect'});assert.ifError(removal.error)
  for(const state of ['disconnecting','disconnect_uncertain']){
    assert.ifError((await admin.from('outreach_connections').update({state}).eq('id',id)).error)
    const takeover: { error: { code: string } | null } = await admin.from('outreach_connections').update({state:'connected',remote_account:f.member.user.email}).eq('id',secondClaim.data![0].connection_id)
    assert.equal(takeover.error?.code,'23505')
  }
})

async function unfinished(f: Awaited<ReturnType<typeof fixture>>, state: 'pending' | 'failed' = 'pending', remote: string | null = String(Math.floor(Math.random()*1e12)+1)) {
  const claim = await f.member.supabase.rpc('prepare_outreach_connection', { p_person: f.person.id, p_channel: 'linkedin', p_action: 'start', p_email: f.member.user.email })
  assert.ifError(claim.error)
  const c = claim.data![0]
  assert.equal((await admin.rpc('finish_outreach_connection', { p_id: c.connection_id, p_lease: c.claim_token!, p_state: state, ...(remote ? { p_remote_account: remote } : {}) })).data, true)
  return { id: c.connection_id, remote }
}

test('an unfinished LinkedIn login can be cancelled by its member and a different email can start only after confirmed removal', async t => {
  const f = await fixture(t), c = await unfinished(f), peer = await createAdmin(t)
  await grantOutreachMembership(peer.user.id, f.tenant.client.id, 'client_member')
  assert.equal((await peer.supabase.rpc('prepare_outreach_disconnect', { p_connection: c.id, p_action: 'cancel' })).error?.code, '42501')
  const people = await f.member.supabase.rpc('list_outreach_people', { p_client: f.tenant.client.id })
  const connection = (people.data as unknown as { connections: { canCancel: boolean; loginEmail: string }[] }[])[0].connections[0]
  assert.equal(connection.canCancel, true); assert.equal(connection.loginEmail, f.member.user.email)
  const cancel = await f.member.supabase.rpc('prepare_outreach_disconnect', { p_connection: c.id, p_action: 'cancel' })
  assert.ifError(cancel.error); assert.equal(cancel.data![0].perform_delete, true)
  const different = 'another-' + randomUUID() + '@example.test'
  assert.equal((await f.member.supabase.rpc('prepare_outreach_connection', { p_person: f.person.id, p_channel: 'linkedin', p_action: 'start', p_email: different })).error?.code, '22023')
  assert.equal((await admin.rpc('finish_outreach_disconnect', { p_id: c.id, p_lease: cancel.data![0].claim_token!, p_outcome: 'removed' })).data, true)
  const next = await f.member.supabase.rpc('prepare_outreach_connection', { p_person: f.person.id, p_channel: 'linkedin', p_action: 'start', p_email: different })
  assert.ifError(next.error); assert.ok(next.data![0].claim_token)
  assert.equal((await admin.from('outreach_connections').select('expected_email').eq('id', next.data![0].connection_id).single()).data?.expected_email, different)
  // Replayed old confirmation cannot affect the replacement.
  assert.equal((await f.member.supabase.rpc('prepare_outreach_disconnect', { p_connection: c.id, p_action: 'cancel' })).data?.[0].perform_delete, false)
  assert.equal((await admin.from('outreach_connection_reservations').select('email').eq('person_id', f.person.id).single()).data?.email, different)
})

test('rejected cancellation restores the failed state; uncertain removal cannot repeat DELETE', async t => {
  const f = await fixture(t), c = await unfinished(f, 'failed')
  const claim = await f.member.supabase.rpc('prepare_outreach_disconnect', { p_connection: c.id, p_action: 'cancel' })
  assert.ifError(claim.error)
  assert.equal((await admin.rpc('finish_outreach_disconnect', { p_id: c.id, p_lease: claim.data![0].claim_token!, p_outcome: 'rejected' })).data, true)
  assert.equal((await admin.from('outreach_connections').select('state').eq('id', c.id).single()).data?.state, 'failed')
  const retry = await f.member.supabase.rpc('prepare_outreach_disconnect', { p_connection: c.id, p_action: 'cancel' })
  assert.ifError(retry.error); assert.equal(retry.data![0].perform_delete, true)
  assert.equal((await admin.rpc('finish_outreach_disconnect', { p_id: c.id, p_lease: retry.data![0].claim_token!, p_outcome: 'uncertain' })).data, true)
  const check = await f.member.supabase.rpc('prepare_outreach_disconnect', { p_connection: c.id, p_action: 'cancel' })
  assert.ifError(check.error); assert.equal(check.data![0].perform_delete, false)
  assert.equal((await admin.from('outreach_connection_reservations').select('email').eq('person_id', f.person.id)).data?.length, 1)
})

test('a definite failure with no remote account can be cleared locally; unknown attempts and connected accounts cannot use cancel', async t => {
  const f = await fixture(t), c = await unfinished(f, 'failed', null)
  const done = await f.member.supabase.rpc('prepare_outreach_disconnect', { p_connection: c.id, p_action: 'cancel' })
  assert.ifError(done.error); assert.equal(done.data![0].claim_token, null)
  assert.equal((await admin.from('outreach_connections').select('state').eq('id', c.id).single()).data?.state, 'disconnected')
  const next = await unfinished(f, 'pending', null)
  assert.equal((await f.member.supabase.rpc('prepare_outreach_disconnect', { p_connection: next.id, p_action: 'cancel' })).error?.code, '22023')
  assert.ifError((await admin.from('outreach_connections').update({ state: 'failed' }).eq('id', next.id)).error)
  await f.member.supabase.rpc('prepare_outreach_disconnect', { p_connection: next.id, p_action: 'cancel' })
  const connected = await f.connect('linkedin')
  assert.equal((await f.member.supabase.rpc('prepare_outreach_disconnect', { p_connection: connected, p_action: 'cancel' })).error?.code, '22023')
})

test('a live status lease blocks cancellation and an old unfinished dialog cannot cancel a newer attempt', async t => {
  const f = await fixture(t), c = await unfinished(f)
  assert.ifError((await admin.from('outreach_connections').update({ next_poll_at: new Date(0).toISOString() }).eq('id', c.id)).error)
  const poll = await f.member.supabase.rpc('prepare_outreach_connection', { p_person: f.person.id, p_channel: 'linkedin', p_action: 'poll' })
  assert.ifError(poll.error); assert.ok(poll.data![0].claim_token)
  const cancel = await f.member.supabase.rpc('prepare_outreach_disconnect', { p_connection: c.id, p_action: 'cancel' })
  assert.ifError(cancel.error); assert.equal(cancel.data![0].claim_token, null)
  await admin.rpc('finish_outreach_connection', { p_id: c.id, p_lease: poll.data![0].claim_token!, p_state: 'failed' })
  assert.ifError((await admin.from('outreach_connections').update({ created_at: new Date(Date.now()-61000).toISOString() }).eq('id', c.id)).error)
  await unfinished(f)
  assert.equal((await f.member.supabase.rpc('prepare_outreach_disconnect', { p_connection: c.id, p_action: 'cancel' })).error?.code, '22023')
})

test('a confirmed disconnect makes earlier failures obsolete when a later rejected login changes email', async t => {
  const f = await fixture(t), first = await unfinished(f, 'failed')
  assert.ifError((await admin.from('outreach_connections').update({ created_at: new Date(Date.now()-120000).toISOString() }).eq('id', first.id)).error)
  const connected = await f.connect('linkedin')
  const cancel = await f.member.supabase.rpc('prepare_outreach_disconnect', { p_connection: connected, p_action: 'disconnect' })
  assert.ifError(cancel.error)
  await admin.rpc('finish_outreach_disconnect', { p_id: connected, p_lease: cancel.data![0].claim_token!, p_outcome: 'removed' })
  const rejected = await unfinished(f, 'failed', null)
  // A historical failed remote sender must not re-lock this person's email after disconnect.
  assert.ifError((await admin.from('outreach_connections').update({ created_at: new Date(Date.now()-60000).toISOString() }).eq('id', connected)).error)
  assert.ifError((await admin.from('outreach_connections').update({ created_at: new Date(Date.now()-31000).toISOString() }).eq('id', rejected.id)).error)
  const next = await f.member.supabase.rpc('prepare_outreach_connection', { p_person: f.person.id, p_channel: 'linkedin', p_action: 'start', p_email: 'replacement-'+randomUUID()+'@example.test' })
  assert.ifError(next.error); assert.ok(next.data![0].claim_token)
})

test('cancel API verifies the exact unfinished sender, deletes once, and confirms absence before switching', async t => {
  const f = await fixture(t), c = await unfinished(f, 'failed'), env = loadTestEnv(), stranger = await createAdmin(t)
  const w = await admin.from('outreach_reply_workspaces').select('credential_ref').eq('client_id', f.tenant.client.id).eq('channel', 'linkedin').single()
  assert.ifError(w.error)
  let removed = false, calls = 0, deletes = 0
  const h = createOnboardingHandlers({ url: env.URL, anonKey: env.ANON, serviceKey: env.SERVICE, fetch,
    credentials: { [w.data!.credential_ref]: 'synthetic' }, providerFetch: async (input, init) => {
      calls++; const url = new URL(String(input))
      if (url.pathname.endsWith('/auth/CheckApiKey')) return new Response(null, { status: 204 })
      if (init?.method === 'DELETE') { assert.ok(url.pathname.endsWith('/RemoveAccount/'+c.remote)); assert.equal(url.searchParams.get('force'), 'false'); deletes++; removed = true; return new Response(null, { status: 204 }) }
      assert.equal(url.searchParams.get('accountId'), c.remote)
      return removed ? Response.json({}, { status: 404 }) : Response.json({ id: c.remote, emailAddress: f.member.user.email, profileUrl: null, activeCampaigns: 0 })
    } })
  const send = async (actor: typeof f.member) => h.connection(new Request('http://localhost/api/onboarding/connections', { method: 'POST', headers: { authorization: 'Bearer '+(await actor.supabase.auth.getSession()).data.session!.access_token, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cancel', connectionId: c.id }) }))
  assert.equal((await send(stranger)).status, 403); assert.equal(calls, 0)
  const result = await send(f.member); assert.equal(result.status, 200)
  const body = await result.json(); assert.equal(body.state, 'disconnected'); assert.equal(body.remoteAccount, undefined); assert.equal(deletes, 1)
  assert.equal((await send(f.member)).status, 200); assert.equal(deletes, 1)
})

test('a rejected pending cancellation restores the member sign-in authority for status checks', async t => {
  const f = await fixture(t), c = await unfinished(f)
  const cancel = await f.member.supabase.rpc('prepare_outreach_disconnect', { p_connection: c.id, p_action: 'cancel' })
  assert.ifError(cancel.error)
  assert.equal((await admin.rpc('finish_outreach_disconnect', { p_id: c.id, p_lease: cancel.data![0].claim_token!, p_outcome: 'rejected' })).data, true)
  assert.ifError((await admin.from('outreach_connections').update({ next_poll_at: new Date(0).toISOString() }).eq('id', c.id)).error)
  const poll = await f.member.supabase.rpc('prepare_outreach_connection', { p_person: f.person.id, p_channel: 'linkedin', p_action: 'poll' })
  assert.ifError(poll.error); assert.ok(poll.data![0].claim_token)
})
