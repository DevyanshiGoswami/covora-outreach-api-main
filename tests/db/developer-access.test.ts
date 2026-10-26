import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { adminClient, anonClient } from '../helpers/admin'
import { createAdmin, createTenant } from '../helpers/tenants'
import { grantOutreachOwner, grantOutreachMembership } from '../helpers/outreach'
import { loadTestEnv } from '../helpers/env'
import { createDeveloperHandlers, tokenHash } from '../../src/lib/developer-session'
import { createDeveloperDataHandler } from '../../src/lib/developer-data'
import { createOnboardingHandlers } from '../../src/lib/onboarding-api'
import { createOutboundSetupHandlers } from '../../src/lib/outbound-api'
import { createOutboundAccountHandlers } from '../../src/lib/outbound-accounts-api'

const db = adminClient(), env = loadTestEnv()
function request(path:string,token:string,method='GET',body?:unknown) {
 return new Request('https://gateway.example.test'+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})})
}
test('central owner sign-in delegates only Covora; other clients, global administration and raw credentials stay inaccessible', async t=>{
 const a=await createTenant(t,{slug:'covora',name:'Covora',features:['outreach_app']})
 const b=await createTenant(t,{name:'Private other client',features:['outreach_app']})
 const owner=await createAdmin(t); await grantOutreachOwner(owner.user.id)
 await grantOutreachMembership(a.user.id,a.client.id,'client_admin')
 const central=(await owner.supabase.auth.getSession()).data.session!.access_token
 const member=(await a.supabase.auth.getSession()).data.session!.access_token
 const config={url:env.URL,anonKey:env.ANON,serviceKey:env.SERVICE,fetch,development:{enabled:true,clientId:a.client.id,serviceKey:env.SERVICE}}
 const sessions=createDeveloperHandlers(config), data=createDeveloperDataHandler(config), onboarding=createOnboardingHandlers(config), setup=createOutboundSetupHandlers(config)
 const issue=await sessions.issue(request('/api/development/session',central,'POST',{}));assert.equal(issue.status,201)
 const issued=await issue.json();const token=issued.token as string
 assert.match(token,/^cdev_[A-Za-z0-9_-]{43}$/);assert.equal(issued.clientId,a.client.id);assert.equal(issued.userId,owner.user.id)
 assert.equal(JSON.stringify(issued).includes(central),false);assert.equal('bearer' in issued,false)
 assert.ok(Date.parse(issued.expiresAt)<=Date.now()+3600000)
 const original=await onboarding.context(request('/api/onboarding/context',central));assert.equal(original.status,200)
 assert.ok((await original.json()).workspaces.some((row:{id:string})=>row.id===b.client.id))
 const restricted=await onboarding.context(request('/api/onboarding/context',token));assert.equal(restricted.status,200)
 const context=await restricted.json();assert.deepEqual(context.workspaces.map((row:{id:string})=>row.id),[a.client.id]);assert.equal(context.isOwner,true);assert.equal(context.canManageClients,false)
 const directory=await data(request('/api/development/data?resource=client_outreach_workspaces&select=client_id,client_name,role,presentation_mode',token))
 assert.equal(directory.status,200);assert.deepEqual((await directory.json()).map((row:{client_id:string})=>row.client_id),[a.client.id])
 for(const suffix of [`&client_id=eq.${b.client.id}`,'&select=client_id,clients(*)','&or=(client_id.neq.x)']) {
  assert.equal((await data(request('/api/development/data?resource=client_outreach_workspaces&select=client_id'+suffix,token))).status,403)
 }
 assert.equal((await sessions.issue(request('/api/development/session',member,'POST',{}))).status,403)
 assert.equal((await sessions.issue(request('/api/development/session',token,'POST',{}))).status,401)
 assert.equal((await sessions.session(request('/api/development/session',central))).status,401)
 assert.equal((await data(request('/api/development/data?resource=clients&select=id',token))).status,403)
 assert.equal((await data(request('/api/development/data?resource=client_outreach_workspaces&select=client_id',central))).status,401)
 const accounts=createOutboundAccountHandlers(config)
 assert.equal((await accounts.GET(request('/api/outbound/accounts?clientId='+b.client.id,token))).status,403)
 const ownPerson=await onboarding.addPerson(request('/api/onboarding/people',token,'POST',{clientId:a.client.id,name:'Developer',email:'developer@example.test'}))
 assert.equal(ownPerson.status,201)
 const otherPerson=await onboarding.addPerson(request('/api/onboarding/people',central,'POST',{clientId:b.client.id,name:'Private person',email:'private@example.test'}))
 assert.equal(otherPerson.status,201);const foreignId=(await otherPerson.json()).personId
 assert.equal((await onboarding.connection(request('/api/onboarding/connections',token,'POST',{action:'poll',personId:foreignId,channel:'email'}))).status,403)
 assert.equal((await onboarding.people(request('/api/onboarding/people?clientId='+b.client.id,token))).status,403)
 assert.equal((await onboarding.createClient(request('/api/onboarding/clients',token,'POST',{id:randomUUID(),name:'Denied'}))).status,403)
 const setupForeign=await setup.POST(request('/api/outbound/setup',central,'POST',{clientId:b.client.id,channel:'email',method:'assisted'}))
 assert.equal(setupForeign.status,200)
 assert.equal((await setup.PATCH(request('/api/outbound/setup',token,'PATCH',{requestId:(await setupForeign.json()).requestId,status:'in_progress',note:'Denied'}))).status,403)
 for(const client of [anonClient(),owner.supabase]) {
   assert.ok((await client.from('outreach_developer_sessions').select('*')).error)
   assert.ok((await client.rpc('read_outreach_developer_session',{p_hash:tokenHash(token),p_client:a.client.id})).error)
   assert.ok((await client.rpc('issue_outreach_developer_session',{p_hash:tokenHash(token),p_user:owner.user.id,p_client:a.client.id,p_bearer:central,p_expires:new Date(Date.now()+60000).toISOString()})).error)
 }
 const messages: string[]=[]
 for (const tenant of [a,b]) {
   const campaign=await db.from('outreach_campaigns').insert({client_id:tenant.client.id,channel:'email',name:'Synthetic scope fixture',provider_campaign_id:randomUUID()}).select('id').single();assert.ifError(campaign.error)
   const message=await db.from('outreach_messages').insert({client_id:tenant.client.id,campaign_id:campaign.data!.id,thread_key:randomUUID(),provider_email_id:randomUUID(),direction:'received',subject:'Synthetic subject',body_text:'Synthetic body',sent_at:new Date().toISOString()}).select('id').single();assert.ifError(message.error);messages.push(message.data!.id)
 }
 const head=request('/api/development/data?resource=client_outreach_messages&select=id',token,'HEAD');head.headers.set('prefer','count=exact')
 const counted=await data(head);assert.equal(counted.status,200);assert.match(counted.headers.get('content-range')??'',/\/1$/)
 const readPath='/api/development/data?resource=mark_outreach_messages_read'
 assert.equal((await data(request(readPath,token,'POST',{ids:messages}))).status,403)
 assert.equal((await data(request(readPath,token,'POST',{ids:[messages[0]]}))).status,200)
 const changed=await db.from('outreach_messages').select('id,client_read_at').in('id',messages);assert.ifError(changed.error)
 assert.ok(changed.data!.find(row=>row.id===messages[0])!.client_read_at)
 assert.equal(changed.data!.find(row=>row.id===messages[1])!.client_read_at,null)
 const bulkCampaign=await db.from('outreach_campaigns').insert({client_id:a.client.id,channel:'email',name:'Bulk mark-read fixture',provider_campaign_id:randomUUID()}).select('id').single();assert.ifError(bulkCampaign.error)
 const bulk=await db.from('outreach_messages').insert(Array.from({length:500},()=>({client_id:a.client.id,campaign_id:bulkCampaign.data!.id,thread_key:randomUUID(),provider_email_id:randomUUID(),direction:'received',sent_at:new Date().toISOString()}))).select('id');assert.ifError(bulk.error)
 assert.equal((await data(request(readPath,token,'POST',{ids:bulk.data!.map(row=>row.id)}))).status,200)
 const read=await db.rpc('read_outreach_developer_session',{p_hash:tokenHash(token),p_client:a.client.id});assert.ifError(read.error);assert.equal((read.data as {bearer:string}).bearer,central)
 assert.equal((await sessions.signout(request('/api/development/session',token,'DELETE'))).status,200)
 assert.equal((await sessions.session(request('/api/development/session',token))).status,401)
 assert.equal((await db.rpc('read_outreach_developer_session',{p_hash:tokenHash(token),p_client:a.client.id})).data,null)
 const second=await sessions.issue(request('/api/development/session',central,'POST',{}));assert.equal(second.status,201);const secondToken=(await second.json()).token
 assert.ifError((await db.from('outreach_agency_memberships').update({state:'suspended'}).eq('user_id',owner.user.id)).error)
 assert.equal((await sessions.session(request('/api/development/session',secondToken))).status,401)
 assert.equal((await data(request('/api/development/data?resource=client_outreach_workspaces&select=client_id',secondToken))).status,401)
 assert.ifError((await db.from('outreach_agency_memberships').update({state:'active'}).eq('user_id',owner.user.id)).error)
 assert.equal((await sessions.session(request('/api/development/session',secondToken))).status,401)
 const disabled=createDeveloperHandlers({...config,development:{...config.development,enabled:false}})
 assert.equal((await disabled.issue(request('/api/development/session',central,'POST',{}))).status,403)
 const wrong=createDeveloperHandlers({...config,development:{...config.development,clientId:b.client.id}})
 assert.equal((await wrong.issue(request('/api/development/session',central,'POST',{}))).status,403)
})
