import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {test,type TestContext} from 'node:test'
import {adminClient,anonClient} from '../helpers/admin'
import {createTenant} from '../helpers/tenants'
import {grantOutreachMembership} from '../helpers/outreach'
import {loadTestEnv} from '../helpers/env'
import {createReachoutHandlers} from '../../src/lib/lead-reachout-api'
const admin=adminClient()
async function fixture(t:TestContext){
 const tenant=await createTenant(t,{features:['outreach_app']});const client=tenant.client.id
 await grantOutreachMembership(tenant.user.id,client,'client_member')
 const list=randomUUID(),lead=randomUUID(),workspace=randomUUID(),sender=randomUUID()
 const ref='OUTREACH_HEYREACH_TEST_'+randomUUID().replaceAll('-','').toUpperCase()
 const remote=String(Math.floor(Math.random()*1e9)+100)
 for(const result of [
  await admin.from('outreach_lead_lists').insert({id:list,client_id:client,name:'Synthetic',source_sha256:'a'.repeat(64)}),
  await admin.from('outreach_imported_leads').insert({id:lead,client_id:client,list_id:list,source_row_id:'b'.repeat(64),first_name:'Test',last_name:'Recipient',linkedin_url:'https://www.linkedin.com/in/synthetic-recipient'}),
  await admin.from('outreach_reply_workspaces').insert({id:workspace,client_id:client,channel:'linkedin',remote_workspace_id:remote,credential_ref:ref,enabled:true}),
  await admin.from('outreach_reply_senders').insert({id:sender,client_id:client,workspace_id:workspace,channel:'linkedin',remote_sender_id:remote,sender_address:'https://www.linkedin.com/in/synthetic-sender',sender_label:'Test sender',enabled:true}),
  await admin.from('outreach_compose_settings').insert({client_id:client,channel:'linkedin',enabled:true}),
 ])assert.ifError(result.error)
 const input={p_client:client,p_lead:lead,p_sender:sender,p_command:randomUUID(),p_recipient:'https://www.linkedin.com/in/synthetic-recipient',p_subject:'',p_body:'Hello, let’s connect.'}
 return {...tenant,clientId:client,lead,sender,workspace,ref,remote,input}
}
test('workspace and recipient are authoritative; viewers, foreign resources, escrow and preview are denied',async t=>{
 const f=await fixture(t), other=await fixture(t)
 assert.equal((await other.supabase.rpc('get_outreach_compose',{p_client:f.clientId})).error?.code,'42501')
 assert.equal((await f.supabase.rpc('prepare_outreach_compose',{...f.input,p_sender:other.sender})).error?.code,'42501')
 assert.equal((await f.supabase.rpc('prepare_outreach_compose',{...f.input,p_lead:other.lead})).error?.code,'42501')
 assert.equal((await f.supabase.rpc('prepare_outreach_compose',{...f.input,p_recipient:'https://www.linkedin.com/in/changed'})).error?.code,'22023')
 await grantOutreachMembership(f.user.id,f.clientId,'client_viewer')
 assert.ifError((await f.supabase.rpc('get_outreach_compose',{p_client:f.clientId,p_lead:f.lead})).error)
 assert.equal((await f.supabase.rpc('prepare_outreach_compose',f.input)).error?.code,'42501')
 await grantOutreachMembership(f.user.id,f.clientId,'client_member')
 assert.ifError((await admin.from('outreach_imported_leads').update({review_state:'escrow',review_reason:'Synthetic',reviewed_at:new Date().toISOString()}).eq('id',f.lead)).error)
 assert.equal((await f.supabase.rpc('prepare_outreach_compose',f.input)).error?.code,'42501')
 assert.ifError((await admin.from('client_features').update({config:{presentation_mode:'preview'}}).eq('client_id',f.clientId)).error)
 assert.equal((await f.supabase.rpc('get_outreach_compose',{p_client:f.clientId})).error?.code,'42501')
 for(const table of ['outreach_compose_settings','outreach_compose_commands'] as const){assert.ok((await f.supabase.from(table).select('*')).error);assert.ok((await anonClient().from(table).select('*')).error)}
})
test('same-command concurrency is idempotent; changed content and a new command for the same recipient conflict',async t=>{
 const f=await fixture(t)
 const results=await Promise.all(Array.from({length:6},()=>f.supabase.rpc('prepare_outreach_compose',f.input)))
 results.forEach(r=>assert.ifError(r.error))
 assert.equal((await admin.from('outreach_compose_commands').select('id').eq('client_id',f.clientId)).data?.length,1)
 assert.equal((await f.supabase.rpc('prepare_outreach_compose',{...f.input,p_body:'Different'})).error?.code,'22023')
 assert.equal((await f.supabase.rpc('prepare_outreach_compose',{...f.input,p_command:randomUUID()})).error?.code,'22023')
 const claim=randomUUID();const args={p_command:f.input.p_command,p_claim:claim,p_claim_first:true}
 assert.ok((await admin.rpc('authorize_outreach_compose',args)).data)
 assert.equal((await admin.rpc('authorize_outreach_compose',args)).data,null)
 assert.ok((await admin.rpc('authorize_outreach_compose',{...args,p_claim_first:false})).data)
 assert.ifError((await admin.from('outreach_memberships').update({state:'revoked'}).eq('client_id',f.clientId).eq('user_id',f.user.id)).error)
 assert.equal((await admin.rpc('authorize_outreach_compose',{...args,p_claim_first:false})).error?.code,'42501')
})
test('disabled sending, edited lead and changed sender configuration fence dispatch',async t=>{
 const f=await fixture(t)
 assert.ifError((await admin.from('outreach_compose_settings').update({enabled:false}).eq('client_id',f.clientId)).error)
 assert.equal((await f.supabase.rpc('prepare_outreach_compose',f.input)).error?.code,'42501')
 assert.ifError((await admin.from('outreach_compose_settings').update({enabled:true}).eq('client_id',f.clientId)).error)
 assert.equal((await f.supabase.rpc('prepare_outreach_compose',{...f.input,p_body:'x'.repeat(201)})).error?.code,'22023')
 assert.equal((await f.supabase.rpc('prepare_outreach_compose',{...f.input,p_body:'Hi {FIRST_NAME}'})).error?.code,'22023')
 assert.ifError((await f.supabase.rpc('prepare_outreach_compose',f.input)).error)
 assert.ifError((await admin.from('outreach_reply_senders').update({enabled:false}).eq('id',f.sender)).error)
 assert.equal((await admin.rpc('authorize_outreach_compose',{p_command:f.input.p_command,p_claim:randomUUID(),p_claim_first:true})).data,null)
})
test('API queues exactly one request and tracks provider evidence without leaking internal IDs',async t=>{
 const f=await fixture(t);const env=loadTestEnv();let launches=0;let observation='ConnectionSent'
 const providerFetch:typeof fetch=async(input,init)=>{
  const u=new URL(String(input));const path=u.pathname;
  if(path.endsWith('/li_account/GetById'))return Response.json({id:Number(f.remote),authIsValid:true})
  if(path.endsWith('/IsConnection'))return Response.json({isConnection:false})
  if(path.endsWith('/CreateEmptyList'))return Response.json({id:100})
  if(path.endsWith('/AddLeadsToListV2')){const body=JSON.parse(String(init?.body));assert.equal(body.leads[0].firstName,'Test');assert.equal(body.leads[0].lastName,'Recipient');assert.deepEqual(body.leads[0].customUserFields,[]);return Response.json({addedLeadsCount:1,updatedLeadsCount:0,failedLeadsCount:0})}
  if(path.endsWith('/GetLeadsFromList'))return Response.json({totalCount:1,items:[{profileUrl:f.input.p_recipient}]})
  if(path.endsWith('/campaign/Create')){const body=JSON.parse(String(init?.body));assert.deepEqual(body.linkedInAccountIds,[Number(f.remote)]);assert.equal(body.sequence.payload.messages[0],f.input.p_body);return Response.json({campaignId:200})}
  if(path.endsWith('/StartCampaign')){launches++;await new Promise(resolve=>setTimeout(resolve,8500));return new Response(null,{status:204})}
  if(path.endsWith('/campaign/GetById'))return Response.json({id:200,organizationUnitId:Number(f.remote),campaignAccountIds:[Number(f.remote)]})
  if(path.endsWith('/GetLeadsFromCampaign'))return Response.json({totalCount:1,items:[{linkedInUserProfile:{profileUrl:f.input.p_recipient},linkedInSenderId:Number(f.remote),leadConnectionStatus:observation,leadMessageStatus:'None',leadCampaignStatus:'InSequence'}]})
  throw new Error('Unexpected simulated endpoint')
 }
 const handlers=createReachoutHandlers({url:env.URL,anonKey:env.ANON,fetch,admin,providerFetch,credentials:{[f.ref]:'synthetic'},enabled:true})
 const token=(await f.supabase.auth.getSession()).data.session!.access_token
 const request=(body:unknown)=>new Request('https://api.example.test/api/outbound/reachout',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)})
 const body={action:'send',clientId:f.clientId,leadId:f.lead,senderId:f.sender,commandId:f.input.p_command,recipient:f.input.p_recipient,subject:'',body:f.input.p_body}
 assert.equal((await handlers.GET(new Request('https://api.example.test/api/outbound/reachout?clientId='+f.clientId))).status,401)
 assert.equal((await handlers.GET(new Request('https://api.example.test/api/outbound/reachout?clientId='+randomUUID(),{headers:{Authorization:`Bearer ${token}`}}))).status,403)
 const response=await handlers.POST(request(body));assert.equal(response.status,200);const result=await response.json();assert.equal(result.context.history[0].status,'queued');assert.equal(launches,1)
 assert.equal(JSON.stringify(result).includes('credentialRef'),false);assert.equal(JSON.stringify(result).includes('remote_campaign_id'),false)
 assert.equal((await handlers.POST(request(body))).status,200);assert.equal(launches,1)
 const refreshed=await handlers.POST(request({action:'refresh',clientId:f.clientId,commandId:f.input.p_command}));assert.equal(refreshed.status,200);assert.equal((await refreshed.json()).history[0].status,'sent')
 observation='ConnectionAccepted';await admin.from('outreach_compose_commands').update({checked_at:null}).eq('id',f.input.p_command)
 const accepted=await handlers.POST(request({action:'refresh',clientId:f.clientId,commandId:f.input.p_command}));assert.equal((await accepted.json()).history[0].status,'connected')
})

test('recipient suppression added after preparation blocks activation',async t=>{
 const f=await fixture(t),campaign=randomUUID(),campaignLead=randomUUID(),claim=randomUUID()
 assert.ifError((await admin.from('outreach_campaigns').insert({id:campaign,client_id:f.clientId,channel:'linkedin',provider_campaign_id:f.remote,name:'Synthetic suppression check',status:'draft'})).error)
 assert.ifError((await admin.from('outreach_leads').insert({id:campaignLead,campaign_id:campaign,client_id:f.clientId,email:'synthetic@example.test',linkedin_url:f.input.p_recipient,status:'not_contacted'})).error)
 assert.ifError((await f.supabase.rpc('prepare_outreach_compose',f.input)).error)
 assert.ok((await admin.rpc('authorize_outreach_compose',{p_command:f.input.p_command,p_claim:claim,p_claim_first:true})).data)
 assert.ifError((await admin.from('outreach_leads').update({status:'unsubscribed'}).eq('id',campaignLead)).error)
 assert.equal((await admin.rpc('authorize_outreach_compose',{p_command:f.input.p_command,p_claim:claim})).data,null)
 assert.equal((await f.supabase.rpc('prepare_outreach_compose',{...f.input,p_command:randomUUID()})).error?.code,'42501')
 assert.equal((await f.supabase.rpc('checkpoint_outreach_compose',{p_command:f.input.p_command,p_claim:claim,p_campaign:'100'})).error?.code,'42501')
})
