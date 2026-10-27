import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createTenant, createAdmin } from '../helpers/tenants'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach'
import { adminClient, anonClient } from '../helpers/admin'
import { loadTestEnv } from '../helpers/env'
import { testDatabaseContainer } from '../helpers/stack'
import { createClickUpHandlers } from '../../src/lib/clickup-api'
const digest=(v:string)=>createHash('sha256').update(v).digest('hex')
const nonce=()=>randomBytes(32).toString('base64url')

test('client-scoped authorization: roles, CSRF, replay, secure metadata, disconnect fencing and revocation',async t=>{
 const tenant=await createTenant(t,{features:['outreach_app']}); const foreign=await createTenant(t,{features:['outreach_app']}); const member=await createAdmin(t);const owner=await createAdmin(t)
 await grantOutreachMembership(tenant.user.id,tenant.client.id); await grantOutreachMembership(foreign.user.id,foreign.client.id); await grantOutreachMembership(member.user.id,tenant.client.id,'client_member'); await grantOutreachOwner(owner.user.id)
 const env=loadTestEnv();let providerCalls=0
 const handlers=createClickUpHandlers({url:env.URL,anonKey:env.ANON,serviceKey:env.SERVICE,fetch,clientId:'synthetic-app',clientSecret:'synthetic-secret',redirectUri:'https://covora.app/auth/clickup/callback',providerFetch:async(input)=>{
  providerCalls++;return String(input).endsWith('/oauth/token')?Response.json({access_token:'synthetic-access-token'}):Response.json({teams:[{id:'private-workspace',name:'Synthetic Workspace',members:['private-member']}]})
 }})
 const token=(await tenant.supabase.auth.getSession()).data.session!.access_token
 const foreignToken=(await foreign.supabase.auth.getSession()).data.session!.access_token
 const memberToken=(await member.supabase.auth.getSession()).data.session!.access_token
 const req=(body?:object,bearer=token,cid=tenant.client.id)=>new Request(`https://backend.invalid/api/outbound/clickup${body?'':`?clientId=${cid}`}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
 const begin=async()=>{const proof=nonce(); const response=await handlers.POST(req({action:'start',clientId:tenant.client.id,browserProof:proof}));assert.equal(response.status,200);const body=await response.json();return {proof,state:body.state as string}}
 const complete=(a:{proof:string;state:string},bearer=token,cid=tenant.client.id)=>handlers.POST(req({action:'complete',clientId:cid,browserProof:a.proof,state:a.state,code:'synthetic-code'},bearer))
 assert.equal((await handlers.GET(req(undefined,foreignToken))).status,403)
 assert.equal((await handlers.GET(req(undefined,memberToken))).status,200)
 assert.equal((await handlers.POST(req({action:'start',clientId:tenant.client.id,browserProof:nonce()},memberToken))).status,403)
 assert.equal((await handlers.POST(req({action:'start',clientId:tenant.client.id,browserProof:nonce()},foreignToken))).status,403)
 assert.equal(providerCalls,0)
 const a=await begin()
 assert.equal((await complete({...a,proof:nonce()})).status,403)
 assert.equal((await complete({...a,state:nonce()})).status,403)
 assert.equal((await complete(a,foreignToken,foreign.client.id)).status,403)
 assert.equal(providerCalls,0)
 assert.equal((await complete(a)).status,200);assert.equal(providerCalls,2)
 assert.equal((await complete(a)).status,403);assert.equal(providerCalls,2)
 const status=await (await handlers.GET(req())).json()
 assert.equal(status.connected,true);assert.deepEqual(status.workspaces,[{name:'Synthetic Workspace'}]);assert.ok(!JSON.stringify(status).includes('private'));assert.ok(!JSON.stringify(status).includes('token'))
 for(const session of [tenant.supabase,foreign.supabase,member.supabase,anonClient()]) {
  assert.ok((await session.from('outreach_crm_connections').select('*')).error)
  assert.ok((await session.from('outreach_crm_authorizations').select('*')).error)
  assert.ok((await session.rpc('complete_outreach_crm_authorization',{p_attempt_id:tenant.client.id,p_token:'forged-token',p_workspaces:[{id:'fake',name:'fake'}]})).error)
 }
 const pending=await begin()
 assert.equal((await handlers.POST(req({action:'disconnect',clientId:tenant.client.id,version:0}))).status,400)
 assert.equal((await handlers.POST(req({action:'disconnect',clientId:tenant.client.id,version:1}))).status,200)
 assert.equal((await complete(pending)).status,403)
 assert.equal((await (await handlers.GET(req())).json()).connected,false)
 const revoked=await begin()
 assert.ifError((await adminClient().from('outreach_memberships').update({state:'revoked'}).eq('user_id',tenant.user.id).eq('client_id',tenant.client.id)).error)
 assert.equal((await complete(revoked)).status,403)
 await grantOutreachMembership(tenant.user.id,tenant.client.id)
 assert.equal((await complete(revoked)).status,403)
 const expired=await begin()
 execFileSync('docker',['exec',testDatabaseContainer,'psql','-U','postgres','-d','postgres','-c',`update public.outreach_crm_authorizations set expires_at=now()-interval '1 second' where state_hash='${digest(expired.state)}'`],{stdio:'pipe'})
 assert.equal((await complete(expired)).status,403)
 const older=await begin();const newer=await begin();assert.equal((await complete(older)).status,403);assert.equal((await complete(newer)).status,200)
 assert.equal((await handlers.POST(req({action:'disconnect',clientId:tenant.client.id,version:3}))).status,200)
 assert.equal((await owner.supabase.rpc('outreach_crm_status',{p_client_id:tenant.client.id})).error,null)
})

test('completion rechecks access after provider exchange and never saves a revoked grant',async t=>{
 const tenant=await createTenant(t,{features:['outreach_app']});await grantOutreachMembership(tenant.user.id,tenant.client.id)
 const proof=nonce(),state=nonce();const args={p_client_id:tenant.client.id,p_state_hash:digest(state),p_browser_hash:digest(proof)}
 assert.ifError((await tenant.supabase.rpc('begin_outreach_crm_authorization',args)).error)
 const attempt=await tenant.supabase.rpc('consume_outreach_crm_authorization',args);assert.ifError(attempt.error)
 assert.ifError((await adminClient().from('client_features').update({enabled:false}).eq('client_id',tenant.client.id).eq('feature','outreach_app')).error)
 const saved=await adminClient().rpc('complete_outreach_crm_authorization',{p_attempt_id:attempt.data!,p_token:'synthetic-token',p_workspaces:[{id:'1',name:'Test'}]})
 assert.equal(saved.error?.code,'42501')
})
