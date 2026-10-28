import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {test,type TestContext} from 'node:test'
import {adminClient,anonClient} from '../helpers/admin'
import {createTenant} from '../helpers/tenants'
import {grantOutreachMembership} from '../helpers/outreach'
const admin=adminClient()
const secret=createHash('sha256').update('synthetic').digest('hex')
async function fixture(t:TestContext){
 const tenant=await createTenant(t,{features:['outreach_app']});await grantOutreachMembership(tenant.user.id,tenant.client.id,'client_member')
 const client=tenant.client.id,workspace=randomUUID(),sender=randomUUID(),campaign=randomUUID(),remote=String(Math.floor(Math.random()*1e9)+100)
 for(const r of [
  await admin.from('outreach_reply_workspaces').insert({id:workspace,client_id:client,channel:'linkedin',remote_workspace_id:remote,credential_ref:'OUTREACH_HEYREACH_TEST_'+randomUUID().replaceAll('-','').toUpperCase(),enabled:false,sync_enabled:true}),
  await admin.from('outreach_reply_senders').insert({id:sender,client_id:client,workspace_id:workspace,channel:'linkedin',remote_sender_id:remote,sender_address:'https://www.linkedin.com/in/synthetic-sender',sender_label:'Synthetic sender',enabled:false}),
  await admin.from('outreach_campaigns').insert({id:campaign,client_id:client,channel:'linkedin',provider_campaign_id:remote,name:'Synthetic',status:'completed'}),
  await admin.from('outreach_linkedin_hooks').insert({workspace_id:workspace,secret_hash:secret,enabled:true}),
 ])assert.ifError(r.error)
 return {...tenant,client,workspace,sender,campaign,remote}
}
async function candidate(campaign:string){
 // Isolated fixtures: other tests may have due scans. Defer them explicitly in this disposable DB.
 assert.ifError((await admin.from('outreach_linkedin_scans').update({due_at:'2099-01-01T00:00:00Z'}).neq('campaign_id',campaign)).error)
 const next=await admin.rpc('next_outreach_linkedin_scan');assert.ifError(next.error);assert.ok(next.data?.length);assert.equal(next.data[0].campaign_id,campaign);return next.data[0]
}
const row=(sender:string,status='connected')=>({senderId:sender,recipient:'https://www.linkedin.com/in/synthetic-recipient',name:'Test Recipient',status})
function args(b:Awaited<ReturnType<typeof candidate>>,rows:unknown[]){return {p_campaign:b.campaign_id,p_workspace:b.workspace_id,p_workspace_version:b.workspace_version,p_sender_ids:b.sender_ids,p_sender_versions:b.sender_versions,p_offset:b.page_offset,p_started:b.started_at,p_next_offset:undefined,p_rows:rows as never}}
test('only authenticated webhook secrets enqueue enabled non-preview workspaces; no public writes',async t=>{
 const f=await fixture(t)
 const payload={p_workspace:f.workspace,p_secret_hash:secret,p_payload_hash:'b'.repeat(64)}
 assert.equal((await admin.rpc('receive_outreach_linkedin_hook',{...payload,p_secret_hash:'c'.repeat(64)})).data,false)
 assert.equal((await admin.from('outreach_linkedin_scans').select('campaign_id').eq('campaign_id',f.campaign)).data?.length,0)
 assert.equal((await admin.rpc('receive_outreach_linkedin_hook',payload)).data,true)
 assert.equal((await admin.rpc('receive_outreach_linkedin_hook',payload)).data,true)
 assert.equal((await admin.from('outreach_linkedin_scans').select('campaign_id').eq('campaign_id',f.campaign)).data?.length,1)
 for(const client of [f.supabase,anonClient()]) {
  assert.ok((await client.rpc('receive_outreach_linkedin_hook',payload)).error)
  assert.ok((await client.rpc('next_outreach_linkedin_scan')).error)
  assert.ok((await client.from('outreach_linkedin_hooks').select('*')).error)
 }
 assert.ifError((await admin.from('client_features').update({config:{presentation_mode:'preview'}}).eq('client_id',f.client)).error)
 assert.equal((await admin.rpc('receive_outreach_linkedin_hook',payload)).data,false)
})
test('status observations are monotonic, tenant scoped, idempotent and expose no provider identities',async t=>{
 const f=await fixture(t);const other=await fixture(t)
 await admin.rpc('receive_outreach_linkedin_hook',{p_workspace:f.workspace,p_secret_hash:secret,p_payload_hash:'d'.repeat(64)})
 // Keep the other fixture ineligible for this batch.
 await admin.from('outreach_linkedin_hooks').update({enabled:false}).eq('workspace_id',other.workspace)
 let b=await candidate(f.campaign)
 const invalid=await admin.rpc('save_outreach_linkedin_scan',args(b,[row(other.sender)]));assert.ok(invalid.error)
 const save=await admin.rpc('save_outreach_linkedin_scan',args(b,[row(f.sender)]));assert.ifError(save.error);assert.equal(save.data,true)
 assert.equal((await admin.rpc('save_outreach_linkedin_scan',args(b,[row(f.sender)]))).data,false)
 await admin.from('outreach_linkedin_scans').update({due_at:new Date(0).toISOString()}).eq('campaign_id',f.campaign)
 b=await candidate(f.campaign);assert.equal((await admin.rpc('save_outreach_linkedin_scan',args(b,[row(f.sender,'sent')]))).data,true)
 const view=await f.supabase.rpc('get_outreach_linkedin_tracking',{p_client:f.client});assert.ifError(view.error)
 const entries=view.data as unknown as Array<Record<string,unknown>>;assert.equal(entries.length,1);assert.equal(entries[0].status,'connected');assert.equal(entries[0].noteAvailable,false);assert.equal(entries[0].source,'synced')
 assert.ok(!JSON.stringify(entries).includes('credential_ref'));assert.ok(!JSON.stringify(entries).includes(f.remote))
 assert.equal((await other.supabase.rpc('get_outreach_linkedin_tracking',{p_client:f.client})).error?.code,'42501')
})
test('configuration changes during a fetch fence saving; a new webhook is not lost on completion',async t=>{
 const f=await fixture(t)
 await admin.rpc('receive_outreach_linkedin_hook',{p_workspace:f.workspace,p_secret_hash:secret,p_payload_hash:'e'.repeat(64)})
 const b=await candidate(f.campaign)
 await admin.from('outreach_reply_workspaces').update({sync_enabled:false}).eq('id',f.workspace)
 assert.equal((await admin.rpc('save_outreach_linkedin_scan',args(b,[row(f.sender)]))).data,false)
 await admin.from('outreach_reply_workspaces').update({sync_enabled:true}).eq('id',f.workspace)
 await admin.from('outreach_linkedin_scans').update({due_at:new Date(0).toISOString(),started_at:null}).eq('campaign_id',f.campaign)
 const fresh=await candidate(f.campaign)
 await admin.rpc('receive_outreach_linkedin_hook',{p_workspace:f.workspace,p_secret_hash:secret,p_payload_hash:'f'.repeat(64)})
 const final=await admin.rpc('save_outreach_linkedin_scan',args(fresh,[row(f.sender)]));assert.ifError(final.error);assert.equal(final.data,true)
 const state=await admin.from('outreach_linkedin_scans').select('due_at,page_offset').eq('campaign_id',f.campaign).single();assert.ifError(state.error);assert.ok(Date.parse(state.data!.due_at)<=Date.now());assert.equal(state.data!.page_offset,0)
})

test('discovery cannot assign a campaign using another workspace’s sender and fences changed configuration',async t=>{
 const f=await fixture(t),other=await fixture(t)
 await admin.from('outreach_linkedin_hooks').update({enabled:false}).eq('workspace_id',other.workspace)
 const claim=await admin.rpc('claim_outreach_linkedin_discovery');assert.ifError(claim.error)
 const b=claim.data as unknown as {workspaceId:string;workspaceVersion:number;claim:string;senders:Array<{id:string;version:number;remoteId:string}>}
 assert.equal(b.workspaceId,f.workspace)
 const input={p_workspace:b.workspaceId,p_version:b.workspaceVersion,p_claim:b.claim,p_senders:b.senders,p_campaigns:[{id:String(Number(f.remote)+1),workspace:f.remote,accounts:[other.remote],name:'Synthetic',status:'active'}]}
 assert.ok((await admin.rpc('save_outreach_linkedin_discovery',input)).error)
 const saved=await admin.rpc('save_outreach_linkedin_discovery',{...input,p_campaigns:[{...input.p_campaigns[0],accounts:[f.remote]}]});assert.ifError(saved.error);assert.equal(saved.data,true)
 assert.equal((await admin.from('outreach_campaigns').select('client_id').eq('provider_campaign_id',input.p_campaigns[0].id).single()).data?.client_id,f.client)
 assert.equal((await f.supabase.rpc('claim_outreach_linkedin_discovery')).error?.code,'42501')
 assert.equal((await admin.rpc('save_outreach_linkedin_discovery',input)).data,false)
})

test('unsigned hints are opt-in, bounded across differing payloads, and cannot establish request status',async t=>{
 const f=await fixture(t),payload={p_workspace:f.workspace,p_payload_hash:'f'.repeat(64)}
 assert.equal((await admin.rpc('receive_outreach_linkedin_hint',payload)).data,false)
 assert.ifError((await admin.from('outreach_linkedin_hooks').update({unsigned_hints_enabled:true}).eq('workspace_id',f.workspace)).error)
 assert.equal((await admin.rpc('receive_outreach_linkedin_hint',payload)).data,true)
 const before=await admin.from('outreach_linkedin_hooks').select('last_received_at,received_count').eq('workspace_id',f.workspace).single();assert.ifError(before.error)
 assert.equal((await admin.rpc('receive_outreach_linkedin_hint',{...payload,p_payload_hash:'a'.repeat(64)})).data,true)
 const after=await admin.from('outreach_linkedin_hooks').select('last_received_at,received_count').eq('workspace_id',f.workspace).single();assert.deepEqual(after.data,before.data)
 assert.equal((await admin.from('outreach_linkedin_scans').select('campaign_id').eq('campaign_id',f.campaign)).data?.length,1)
 assert.equal((await admin.from('outreach_linkedin_requests').select('id').eq('client_id',f.client)).data?.length,0)
 for(const client of [f.supabase,anonClient()])assert.ok((await client.rpc('receive_outreach_linkedin_hint',payload)).error)
 assert.ifError((await admin.from('outreach_linkedin_hooks').update({last_received_at:new Date(0).toISOString()}).eq('workspace_id',f.workspace)).error)
 assert.equal((await admin.rpc('receive_outreach_linkedin_hint',payload)).data,true)
 assert.equal((await admin.from('outreach_linkedin_hooks').select('received_count').eq('workspace_id',f.workspace).single()).data?.received_count,2)
 assert.ifError((await admin.from('client_features').update({config:{presentation_mode:'preview'}}).eq('client_id',f.client)).error)
 assert.equal((await admin.rpc('receive_outreach_linkedin_hint',payload)).data,false)
})
