import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { adminClient, anonClient } from '../helpers/admin'
import { createTenant } from '../helpers/tenants'
import { grantOutreachOwner, grantOutreachMembership } from '../helpers/outreach'
import { loadTestEnv } from '../helpers/env'
import { createAdminIntegrationHandlers } from '../../src/lib/admin-integrations-api'
import { createOnboardingHandlers } from '../../src/lib/onboarding-api'
import { resolveIntegrationCredential } from '../../src/lib/integration-credentials'
const env=loadTestEnv(); const admin=adminClient()
async function request(client: ReturnType<typeof anonClient>, body?:unknown) {
  const token=(await client.auth.getSession()).data.session?.access_token
  return new Request('http://localhost/api/onboarding/admin-integrations',{method:body ? 'POST' : 'GET',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},...(body ? {body:JSON.stringify(body)} : {})})
}
test('owner saves encrypted connections, clients cannot read keys, and saved keys power onboarding', async () => {
  const owner=await createTenant(null,{features:['outreach_app']}); await grantOutreachOwner(owner.user.id)
  const tenant=await createTenant(null,{features:['outreach_app']}); await grantOutreachMembership(tenant.user.id,tenant.client.id)
  const id=randomUUID(); const workspace=randomUUID(); const key=`synthetic-${randomUUID()}`; const session=randomUUID()
  let good=true; let providerCalls=0
  const providerFetch:typeof fetch=async (input,init)=>{
    providerCalls++
    assert.equal(new Headers(init?.headers).get('Authorization'),`Bearer ${key}`)
    if (!good) return Response.json({}, {status:401})
    const url=new URL(String(input))
    if (url.pathname.endsWith('/workspaces/current')) return Response.json({id:workspace})
    if (url.pathname.endsWith('/oauth/google/init')) return Response.json({session_id:session,auth_url:'https://accounts.google.com/o/oauth2/auth?state=synthetic',expires_at:new Date(Date.now()+60000).toISOString()})
    throw new Error('Unexpected provider request')
  }
  const config={url:env.URL,anonKey:env.ANON,serviceKey:env.SERVICE,fetch,providerFetch}
  const handlers=createAdminIntegrationHandlers(config)
  const save={action:'save',id,version:0,channel:'email',label:'Managed email',apiKey:key}
  try {
    assert.equal((await handlers.POST(await request(tenant.supabase,save))).status,403)
    assert.equal(providerCalls,0)
    const saved=await handlers.POST(await request(owner.supabase,save)); assert.equal(saved.status,200,await saved.clone().text())
    const list=await handlers.GET(await request(owner.supabase)); assert.equal(list.status,200)
    const text=await list.text(); for(const privateValue of [key,workspace,'secret_id','credential_ref']) assert.ok(!text.includes(privateValue))
    const rows=JSON.parse(text).integrations; assert.equal(rows.find((row:{id:string})=>row.id===id).version,1)
    assert.equal((await handlers.GET(await request(tenant.supabase))).status,403)
    const stored=await admin.from('outreach_integrations').select('credential_ref,secret_id').eq('id',id).single(); assert.ifError(stored.error)
    assert.equal(await resolveIntegrationCredential(stored.data!.credential_ref,{},admin),key)
    assert.equal((await tenant.supabase.rpc('read_outreach_integration_key',{p_ref:stored.data!.credential_ref})).error?.code,'42501')
    assert.equal((await owner.supabase.rpc('read_outreach_integration_key',{p_ref:stored.data!.credential_ref})).error?.code,'42501')
    assert.equal((await tenant.supabase.from('outreach_integrations').select('secret_id')).error?.code,'42501')
    const onboarding=createOnboardingHandlers(config)
    const token=(await owner.supabase.auth.getSession()).data.session!.access_token
    const bind=new Request('http://localhost/api/onboarding/integrations',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({clientId:tenant.client.id,optionId:`managed-${id}`})})
    const bound=await onboarding.bindIntegration(bind); assert.equal(bound.status,200,await bound.clone().text())
    const assignmentResponse = await onboarding.integrations(new Request(`http://localhost/api/onboarding/integrations?clientId=${tenant.client.id}`, { headers: { Authorization: `Bearer ${token}` } }))
    assert.equal(assignmentResponse.status, 200)
    const assignmentText = await assignmentResponse.text()
    assert.deepEqual(JSON.parse(assignmentText).assignments, { email: { optionId: `managed-${id}`, label: 'Managed email', enabled: true }, linkedin: null })
    for (const secret of [key, workspace, stored.data!.credential_ref, stored.data!.secret_id]) assert.ok(!assignmentText.includes(secret))
    const person=await tenant.supabase.rpc('create_outreach_person',{p_client_id:tenant.client.id,p_name:'Test',p_email:tenant.user.email}); assert.ifError(person.error)
    const clientToken=(await tenant.supabase.auth.getSession()).data.session!.access_token
    const clientConnections = await onboarding.integrations(new Request(`http://localhost/api/onboarding/integrations?clientId=${tenant.client.id}`, { headers: { Authorization: `Bearer ${clientToken}` } }))
    const clientConnectionsBody = await clientConnections.json()
    assert.equal(clientConnectionsBody.assignments, undefined); assert.deepEqual(clientConnectionsBody.options, [])
    const start=await onboarding.connection(new Request('http://localhost/api/onboarding/connections',{method:'POST',headers:{Authorization:`Bearer ${clientToken}`,'Content-Type':'application/json'},body:JSON.stringify({action:'start',channel:'email',personId:person.data})}))
    assert.equal(start.status,200,await start.clone().text()); assert.equal((await start.json()).state,'pending')
    assert.equal((await handlers.POST(await request(owner.supabase,{...save,version:1}))).status,400)
    assert.equal((await handlers.POST(await request(owner.supabase,{action:'remove',id,version:1}))).status,400)
    assert.ifError((await admin.from('outreach_connections').update({expires_at:new Date(0).toISOString()}).eq('person_id',person.data!)).error)
    assert.equal((await handlers.POST(await request(owner.supabase,{...save,version:1}))).status,200)
    good=false
    const check=await handlers.POST(await request(owner.supabase,{action:'check',id,version:2})); assert.equal(check.status,200); assert.equal((await check.json()).verified,false)
    assert.equal((await handlers.POST(await request(owner.supabase,{...save,version:2}))).status,400)
    assert.equal(await resolveIntegrationCredential(stored.data!.credential_ref,{},admin),key)
  } finally {
    await tenant.cleanup()
    const current=await admin.from('outreach_integrations').select('version').eq('id',id).maybeSingle()
    if(current.data) assert.equal((await handlers.POST(await request(owner.supabase,{action:'remove',id,version:current.data.version}))).status,200)
    await owner.cleanup()
  }
})
test('rotation, stale edits, failed validation, revoked owners and removal are fenced', async () => {
  const owner=await createTenant(null,{features:['outreach_app']}); await grantOutreachOwner(owner.user.id)
  const id=randomUUID(); const workspace=randomUUID(); const key=`synthetic-${randomUUID()}`
  let valid=true
  const providerFetch:typeof fetch=async ()=>valid ? new Response(null,{status:200}) : Response.json({error:key},{status:403})
  const handlers=createAdminIntegrationHandlers({url:env.URL,anonKey:env.ANON,serviceKey:env.SERVICE,fetch,providerFetch})
  const save={action:'save',id,version:0,channel:'linkedin',label:'Managed social',workspaceId:workspace,apiKey:key}
  try {
    const created=await handlers.POST(await request(owner.supabase,save)); assert.equal(created.status,200,await created.clone().text())
    assert.equal((await handlers.POST(await request(owner.supabase,save))).status,400)
    valid=false
    const failed=await handlers.POST(await request(owner.supabase,{...save,version:1,apiKey:`replacement-${randomUUID()}`}))
    assert.equal(failed.status,400)
    const failureBody = await failed.text(); assert.ok(!failureBody.includes(key))
    assert.equal(JSON.parse(failureBody).code, 'provider_access_denied')
    assert.equal((await admin.from('outreach_integrations').select('version').eq('id',id).single()).data?.version,1)
    valid=true
    const replacement=`synthetic-new-${randomUUID()}`
    assert.equal((await handlers.POST(await request(owner.supabase,{...save,version:1,apiKey:replacement}))).status,200)
    const stored=await admin.from('outreach_integrations').select('credential_ref,version').eq('id',id).single()
    assert.equal(stored.data?.version,2); assert.equal(await resolveIntegrationCredential(stored.data!.credential_ref,{},admin),replacement)
    assert.equal((await handlers.POST(await request(owner.supabase,{action:'check',id,version:1}))).status,400)
    const authority=await admin.from('outreach_agency_memberships').select('version').eq('user_id',owner.user.id).single()
    assert.ifError((await admin.from('outreach_agency_memberships').update({state:'suspended'}).eq('user_id',owner.user.id)).error)
    assert.equal((await handlers.POST(await request(owner.supabase,{action:'remove',id,version:2}))).status,403)
    assert.equal((await admin.rpc('remove_outreach_integration',{p_actor:owner.user.id,p_actor_version:authority.data!.version,p_id:id,p_version:2})).error?.code,'42501')
    await grantOutreachOwner(owner.user.id)
    assert.equal((await admin.rpc('check_outreach_integration',{p_actor:owner.user.id,p_actor_version:authority.data!.version,p_id:id,p_version:2,p_ok:true})).error?.code,'42501')
    assert.equal((await handlers.POST(await request(owner.supabase,{action:'remove',id,version:2}))).status,200)
    assert.equal(await resolveIntegrationCredential(stored.data!.credential_ref,{},admin),undefined)
  } finally {
    await grantOutreachOwner(owner.user.id)
    const current=await admin.from('outreach_integrations').select('version').eq('id',id).maybeSingle()
    if(current.data) await handlers.POST(await request(owner.supabase,{action:'remove',id,version:current.data.version}))
    await owner.cleanup()
  }
})
