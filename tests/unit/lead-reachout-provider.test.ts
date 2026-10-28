import assert from 'node:assert/strict'
import {test} from 'node:test'
import {dispatchReachout,observeReachout,ReachoutFailure} from '../../src/lib/lead-reachout-provider'
const command={id:'10000000-0000-4000-8000-000000000001',channel:'linkedin' as const,recipient:'https://www.linkedin.com/in/test-recipient',recipientName:'Test',subject:'',body:'An exact note.'}
const binding={remoteSender:'12',workspace:'99'}
test('already-connected leads never reach a mutation',async()=>{
 const paths:string[]=[]
 await assert.rejects(()=>dispatchReachout(command,binding,{key:'synthetic',checkpoint:async()=>{},authorize:async()=>{},fetch:async input=>{const path=new URL(String(input)).pathname;paths.push(path);return Response.json(path.endsWith('GetById')?{id:12,authIsValid:true}:{isConnection:true})}}),e=>e instanceof ReachoutFailure&&e.code==='already_connected')
 assert.equal(paths.length,2)
})
test('transport failure on mutation is uncertain and never retried',async()=>{
 let mutations=0
 await assert.rejects(()=>dispatchReachout(command,binding,{key:'synthetic',checkpoint:async()=>{},authorize:async()=>{},fetch:async input=>{const path=new URL(String(input)).pathname;if(path.endsWith('GetById'))return Response.json({id:12,authIsValid:true});if(path.endsWith('IsConnection'))return Response.json({isConnection:false});mutations++;throw new Error('private transport diagnostics')}}),e=>e instanceof ReachoutFailure&&e.uncertain)
 assert.equal(mutations,1)
})
test('revocation before activation leaves a draft and never starts it',async()=>{
 let checks=0,starts=0
 await assert.rejects(()=>dispatchReachout(command,binding,{key:'synthetic',checkpoint:async()=>{},authorize:async()=>{if(++checks===2)throw new ReachoutFailure('provider_rejected')},fetch:async input=>{const path=new URL(String(input)).pathname;if(path.endsWith('GetById'))return Response.json({id:12,authIsValid:true});if(path.endsWith('IsConnection'))return Response.json({isConnection:false});if(path.endsWith('CreateEmptyList'))return Response.json({id:20});if(path.endsWith('AddLeadsToListV2'))return Response.json({addedLeadsCount:1,updatedLeadsCount:0,failedLeadsCount:0});if(path.endsWith('GetLeadsFromList'))return Response.json({totalCount:1,items:[{profileUrl:command.recipient}]});if(path.endsWith('Create'))return Response.json({campaignId:30});starts++;return new Response(null,{status:204})}}))
 assert.equal(starts,0)
})
test('unrelated sender or recipient observations cannot mark requests sent',async()=>{
 await assert.rejects(()=>observeReachout(command,binding,'30',{key:'synthetic',fetch:async input=>Response.json(String(input).includes('GetById')?{id:30,organizationUnitId:99,campaignAccountIds:[12]}:{totalCount:1,items:[{linkedInUserProfile:{profileUrl:'https://www.linkedin.com/in/another'},linkedInSenderId:12,leadConnectionStatus:'ConnectionSent',leadMessageStatus:'None',leadCampaignStatus:'Finished'}]})}))
})

test('email queues one exact recipient and escaped message, with authorization before activation',async()=>{
 const workspace='20000000-0000-4000-8000-000000000001',campaign='30000000-0000-4000-8000-000000000001'
 const email={...command,channel:'email' as const,recipient:'recipient@example.test',subject:'A personal hello',body:'Hi <Test> & friends\nLet’s connect.'}
 let checks=0,checkpoints=0,activations=0
 const result=await dispatchReachout(email,{remoteSender:'sender@example.test',workspace},{key:'synthetic',authorize:async()=>{checks++},checkpoint:async id=>{assert.equal(id,campaign);checkpoints++},fetch:async(input,init)=>{
  const path=new URL(String(input)).pathname
  if(path.endsWith('/workspaces/current'))return Response.json({id:workspace})
  if(path.includes('/accounts/'))return Response.json({organization:workspace,email:'sender@example.test',status:1,setup_pending:false})
  if(path.endsWith('/campaigns')){
   const body=JSON.parse(String(init?.body))
   assert.deepEqual(body.email_list,['sender@example.test'])
   assert.deepEqual(body.sequences,[{steps:[{type:'email',delay:0,variants:[{subject:email.subject,body:'Hi &lt;Test&gt; &amp; friends<br/>Let’s connect.'}]}]}])
   assert.equal(body.open_tracking,false);assert.equal(body.link_tracking,false)
   return Response.json({id:campaign})
  }
  if(path.endsWith('/leads')){const body=JSON.parse(String(init?.body));assert.equal(body.email,email.recipient);assert.equal(body.campaign,campaign);return Response.json({id:command.id,email:email.recipient,campaign})}
  if(path.endsWith('/activate')){assert.equal(checks,2);assert.equal(checkpoints,1);activations++;return Response.json({id:campaign})}
  throw new Error('Unexpected endpoint')
 }})
 assert.equal(result.status,'queued');assert.equal(activations,1)
})

test('an ambiguous launch result is retained as unknown and is never retried',async()=>{
 let starts=0
 await assert.rejects(()=>dispatchReachout(command,binding,{key:'synthetic',checkpoint:async()=>{},authorize:async()=>{},fetch:async input=>{
  const path=new URL(String(input)).pathname
  if(path.endsWith('GetById'))return Response.json({id:12,authIsValid:true})
  if(path.endsWith('IsConnection'))return Response.json({isConnection:false})
  if(path.endsWith('CreateEmptyList'))return Response.json({id:20})
  if(path.endsWith('AddLeadsToListV2'))return Response.json({addedLeadsCount:1,updatedLeadsCount:0,failedLeadsCount:0});if(path.endsWith('GetLeadsFromList'))return Response.json({totalCount:1,items:[{profileUrl:command.recipient}]})
  if(path.endsWith('Create'))return Response.json({campaignId:30})
  starts++;return new Response(null,{status:502})
 }}),error=>error instanceof ReachoutFailure&&error.uncertain&&error.code==='outcome_unknown')
 assert.equal(starts,1)
})

for(const scenario of ['failed_import','wrong_recipient'] as const){
 test(`recipient setup ${scenario} cannot create or launch a campaign`,async()=>{
  let campaigns=0
  await assert.rejects(()=>dispatchReachout({...command,recipientName:'Test Recipient'},binding,{key:'synthetic',checkpoint:async()=>{},authorize:async()=>{},fetch:async(input,init)=>{
   const path=new URL(String(input)).pathname
   if(path.endsWith('GetById'))return Response.json({id:12,authIsValid:true})
   if(path.endsWith('IsConnection'))return Response.json({isConnection:false})
   if(path.endsWith('CreateEmptyList'))return Response.json({id:20})
   if(path.endsWith('AddLeadsToListV2')){const body=JSON.parse(String(init?.body));assert.deepEqual(body.leads[0],{profileUrl:command.recipient,firstName:'Test',lastName:'Recipient',location:'',summary:'',companyName:'',position:'',about:'',emailAddress:'',customUserFields:[]});return Response.json({addedLeadsCount:scenario==='failed_import'?0:1,updatedLeadsCount:0,failedLeadsCount:scenario==='failed_import'?1:0})}
   if(path.endsWith('GetLeadsFromList'))return Response.json({totalCount:1,items:[{profileUrl:'https://www.linkedin.com/in/incorrect-recipient'}]})
   campaigns++;throw new Error('Must not create or launch a campaign')
  }}),error=>error instanceof ReachoutFailure&&error.code==='provider_rejected')
  assert.equal(campaigns,0)
 })
}
