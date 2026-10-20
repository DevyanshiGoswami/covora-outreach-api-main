import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import test from 'node:test'
import {adminClient,anonClient} from '../helpers/admin.ts'
import {createTenant} from '../helpers/tenants.ts'
import {grantOutreachMembership} from '../helpers/outreach.ts'
const admin=adminClient()
const remote=()=>String(Math.floor(Math.random()*1e10)+1)
test('shared network workspace keeps private assignments, nullable metrics, channel separation and tenant denial',async t=>{
 const a=await createTenant(t,{features:['outreach_app']}),b=await createTenant(t,{features:['outreach_app']})
 const workspace=remote(),ref='OUTREACH_HEYREACH_TEST_'+randomUUID().replaceAll('-','').toUpperCase()
 const rows=[]
 for(const tenant of [a,b]){
  await grantOutreachMembership(tenant.user.id,tenant.client.id,'client_viewer')
  const binding=await admin.from('outreach_reply_workspaces').insert({client_id:tenant.client.id,channel:'linkedin',remote_workspace_id:workspace,credential_ref:ref,sync_enabled:true,enabled:false}).select('*').single();assert.ifError(binding.error)
  const sender=await admin.from('outreach_reply_senders').insert({client_id:tenant.client.id,channel:'linkedin',workspace_id:binding.data!.id,remote_sender_id:remote(),sender_address:'https://www.linkedin.com/in/example',sender_label:'Example'}).select('*').single();assert.ifError(sender.error)
  const c=await admin.from('outreach_campaigns').insert({client_id:tenant.client.id,channel:'linkedin',provider_campaign_id:remote(),name:'Network'}).select('*').single();assert.ifError(c.error)
  // Campaign assignment bumps sender version to fence cached scopes.
  const s=await admin.from('outreach_reply_senders').select('*').eq('id',sender.data!.id).single();assert.ifError(s.error)
  const args={p_campaign_id:c.data!.id,p_workspace_id:binding.data!.id,p_workspace_version:binding.data!.version,p_sender_ids:[s.data!.id],p_sender_versions:[s.data!.version],p_name:'Network',p_status:'active',p_totals:{leads:47,invitations_sent:0,invitations_accepted:null,messages_sent:null,replies:null,secret_provider_id:'never-show'}}
  const saved=await admin.rpc('save_outreach_network_campaign',args);assert.ifError(saved.error);assert.equal(saved.data,true)
  rows.push({tenant,binding:binding.data!,sender:s.data!,c:c.data!,args})
 }
 for(const own of rows){
  const other: (typeof rows)[number]=rows.find(r=>r!==own)!
  const view=await own.tenant.supabase.from('client_outreach_network_campaigns').select('*');assert.ifError(view.error);assert.equal(view.data!.length,1);assert.equal(view.data![0].id,own.c.id)
  assert.deepEqual(view.data![0].totals,{leads:47,invitations_sent:0,invitations_accepted:null,messages_sent:null,replies:null})
  assert.doesNotMatch(JSON.stringify(view.data),/never-show|credential|provider_campaign_id|remote_workspace_id/)
  const email=await own.tenant.supabase.from('client_outreach_campaigns').select('*');assert.ifError(email.error);assert.equal(email.data!.length,0)
  assert.ok((await own.tenant.supabase.rpc('save_outreach_network_campaign',own.args)).error)
  assert.ok((await own.tenant.supabase.from('outreach_reply_workspaces').select('*')).error)
  assert.equal((await admin.rpc('save_outreach_network_campaign',{...own.args,p_workspace_id:other.binding.id})).data,false)
  assert.equal((await admin.rpc('save_outreach_network_campaign',{...own.args,p_sender_ids:[other.sender.id],p_sender_versions:[other.sender.version]})).data,false)
  assert.equal((await admin.rpc('save_outreach_network_campaign',{...own.args,p_workspace_version:999})).data,false)
  assert.equal((await admin.rpc('save_outreach_network_campaign',{...own.args,p_workspace_version:null as unknown as number})).data,false)
  assert.equal((await admin.rpc('save_outreach_network_campaign',{...own.args,p_sender_versions:[999]})).data,false)
  assert.ok((await admin.from('outreach_reply_senders').insert({client_id:own.tenant.client.id,channel:'linkedin',workspace_id:own.binding.id,remote_sender_id:other.sender.remote_sender_id,sender_address:'https://www.linkedin.com/in/example',sender_label:'Duplicated'})).error)
 }
 assert.ok((await anonClient().from('client_outreach_network_campaigns').select('*')).error)
 const c=await createTenant(t,{features:['outreach_app']})
 assert.equal((await admin.from('outreach_reply_workspaces').insert({client_id:c.client.id,channel:'linkedin',remote_workspace_id:remote(),credential_ref:ref})).error?.code,'22023')
 const own=rows[0];assert.ifError((await admin.from('client_features').update({enabled:false}).eq('client_id',own.tenant.client.id).eq('feature','outreach_app')).error)
 const disabled=await own.tenant.supabase.from('client_outreach_network_campaigns').select('*');assert.ifError(disabled.error);assert.equal(disabled.data!.length,0)
 assert.equal((await admin.rpc('save_outreach_network_campaign',own.args)).data,false)
})

test('reviewed directory overlays live activity without duplicating, losing rank or publishing escrow',async t=>{
 const tenant=await createTenant(t,{features:['outreach_app']});await grantOutreachMembership(tenant.user.id,tenant.client.id,'client_viewer')
 const list=randomUUID(),campaign=randomUUID(),second=randomUUID(),published=randomUUID(),bounced=randomUUID(),held=randomUUID()
 const stamp='2026-10-20T00:00:00+00:00'
 assert.ifError((await admin.from('outreach_lead_lists').insert({id:list,client_id:tenant.client.id,name:'Priority',source_sha256:'c'.repeat(64)})).error)
 assert.ifError((await admin.from('outreach_imported_leads').insert([
 {id:published,client_id:tenant.client.id,list_id:list,source_row_id:'1'.repeat(64),email:'person@example.test',first_name:'Reviewed',last_name:'Person',review_state:'client',priority_rank:1,email_verification:'verified',email_verification_evidence:'Synthetic validated source',fit_reason:'Reviewed fit',reviewed_at:stamp,review_evidence:{emailValidation:'valid'}},
 {id:bounced,client_id:tenant.client.id,list_id:list,source_row_id:'2'.repeat(64),email:'bounced@example.test',first_name:'Bounced',last_name:'Person',review_state:'client',priority_rank:2,email_verification:'verified',email_verification_evidence:'Synthetic validated source',fit_reason:'Reviewed fit',reviewed_at:stamp,review_evidence:{emailValidation:'valid'}},
 {id:held,client_id:tenant.client.id,list_id:list,source_row_id:'3'.repeat(64),email:'held@example.test',email_verification:'unknown',first_name:'Held',last_name:'Person',review_state:'escrow',review_reason:'Needs research',reviewed_at:stamp,review_evidence:{}},
 ])).error)
 assert.ifError((await admin.from('outreach_campaigns').insert([campaign,second].map((id,i)=>({id,client_id:tenant.client.id,provider_campaign_id:randomUUID(),name:'Real email '+i})))).error)
 assert.ifError((await admin.from('outreach_leads').insert([
 {campaign_id:campaign,client_id:tenant.client.id,email:'Person@example.test',first_name:'Provider duplicate',email_verification:'unknown',status:'contacted',last_activity_at:stamp},
 {campaign_id:second,client_id:tenant.client.id,email:'person@example.test',first_name:'Another campaign',email_verification:'unknown',status:'not_contacted'},
 {campaign_id:campaign,client_id:tenant.client.id,email:'bounced@example.test',first_name:'Stale verified',email_verification:'verified',status:'bounced',last_activity_at:stamp},
 {campaign_id:campaign,client_id:tenant.client.id,email:'held@example.test',first_name:'Provider held',email_verification:'unknown',status:'contacted'},
 ])).error)
 const read=async(args:Record<string,string>={})=>{
  const response=await tenant.supabase.rpc('list_outreach_leads',{p_client_id:tenant.client.id,...args});assert.ifError(response.error)
  return response.data as unknown as {total:number;leads:{id:string;firstName:string;campaignId:string;status:string;lastActivityAt:string;priorityRank:number;emailVerification:string;emailValidation?:string}[];summary:{verifiedEmail:number};campaigns:{id:string}[]}
 }
 const page=await read()
 assert.equal(page.total,2);assert.equal(page.leads[0].id,published);assert.equal(page.leads[0].firstName,'Reviewed');assert.equal(page.leads[0].priorityRank,1)
 assert.equal(page.leads[0].emailVerification,'verified');assert.equal(page.leads[0].status,'contacted');assert.equal(page.leads[0].campaignId,campaign);assert.equal(Date.parse(page.leads[0].lastActivityAt),Date.parse(stamp))
 assert.equal(page.leads[1].id,bounced);assert.equal(page.leads[1].status,'bounced');assert.equal(page.leads[1].emailVerification,'unverified');assert.equal(page.leads[1].emailValidation,'invalid');assert.equal(page.summary.verifiedEmail,1)
 const selected=await read({p_campaign:second});assert.equal(selected.total,1);assert.equal(selected.leads[0].campaignId,second);assert.equal((await read({p_status:'contacted'})).total,1);assert.equal((await read({p_email:'verified'})).total,1)
 assert.deepEqual(new Set(page.campaigns.map(c=>c.id)),new Set([campaign,second]))
 const source=await admin.from('outreach_imported_leads').select('id,status,email_verification,review_state').eq('client_id',tenant.client.id);assert.ifError(source.error)
 assert.equal(source.data!.find(r=>r.id===bounced)!.email_verification,'verified');assert.ok(source.data!.every(r=>r.status==='not_contacted'));assert.equal(source.data!.find(r=>r.id===held)!.review_state,'escrow')
 const mirror=await admin.from('outreach_leads').select('id').eq('client_id',tenant.client.id);assert.equal(mirror.data!.length,4)
})

test('eligible campaign selection ignores ten older disabled assignments and enforces service-only access',async t=>{
 const inactive=await createTenant(t,{features:['outreach_app']}),active=await createTenant(t,{features:['outreach_app']})
 const ref='OUTREACH_HEYREACH_'+randomUUID().replaceAll('-','').toUpperCase()
 for(const [tenant,sync_enabled] of [[inactive,false],[active,true]] as const){
  assert.ifError((await admin.from('outreach_reply_workspaces').insert({client_id:tenant.client.id,channel:'linkedin',remote_workspace_id:remote(),credential_ref:ref+(sync_enabled?'_A':'_B'),sync_enabled})).error)
 }
 assert.ifError((await admin.from('outreach_campaigns').insert(Array.from({length:10},()=>({client_id:inactive.client.id,channel:'linkedin',provider_campaign_id:remote(),name:'Disabled'})))).error)
 const candidate=await admin.from('outreach_campaigns').insert({client_id:active.client.id,channel:'linkedin',provider_campaign_id:remote(),name:'Eligible'}).select('id').single();assert.ifError(candidate.error)
 assert.ifError((await admin.from('outreach_sync_state').update({last_served_at:new Date().toISOString()}).eq('campaign_id',candidate.data!.id)).error)
 const selected=await admin.rpc('next_outreach_network_campaign');assert.ifError(selected.error);assert.equal(selected.data![0].id,candidate.data!.id)
 assert.ok((await active.supabase.rpc('next_outreach_network_campaign')).error);assert.ok((await anonClient().rpc('next_outreach_network_campaign')).error)
 assert.ifError((await admin.from('client_features').update({enabled:false}).eq('client_id',active.client.id).eq('feature','outreach_app')).error)
 const none=await admin.rpc('next_outreach_network_campaign');assert.ifError(none.error);assert.deepEqual(none.data,[])
})

test('malformed stored network metrics project as null rather than zero or executable data',async t=>{
 const tenant=await createTenant(t,{features:['outreach_app']});await grantOutreachMembership(tenant.user.id,tenant.client.id,'client_viewer')
 assert.ifError((await admin.from('outreach_campaigns').insert({client_id:tenant.client.id,channel:'linkedin',provider_campaign_id:remote(),name:'Test',totals:{leads:'unknown',invitations_sent:-1,invitations_accepted:2.5,messages_sent:null,replies:0,secret:'hidden'}})).error)
 const result=await tenant.supabase.from('client_outreach_network_campaigns').select('totals');assert.ifError(result.error)
 assert.deepEqual(result.data![0].totals,{leads:null,invitations_sent:null,invitations_accepted:null,messages_sent:null,replies:0})
})
