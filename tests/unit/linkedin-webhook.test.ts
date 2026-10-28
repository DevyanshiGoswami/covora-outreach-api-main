import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHash,randomUUID} from 'node:crypto'
import {createLinkedinWebhook} from '../../src/lib/linkedin-webhook'
import {canonicalLinkedinProfile,readLinkedinRequestPage,type RequestScan} from '../../src/lib/linkedin-request-sync'
const workspace=randomUUID(), secret='a'.repeat(64)
function request(body:unknown={},header:string|null=secret){return new Request(`https://example.test/api/webhooks/linkedin/${workspace}`,{method:'POST',headers:{...(header?{'x-covora-webhook-secret':header}:{}),'content-type':'application/json'},body:JSON.stringify(body)})}
test('webhooks reject malformed credentials and oversize bodies without persisting anything',async()=>{
 let writes=0;const handler=createLinkedinWebhook(async()=>{writes++;return true})
 assert.equal((await handler(request({},'short'),workspace)).status,401)
 assert.equal((await handler(request(), 'not-a-workspace')).status,401)
 assert.equal((await handler(request({data:'x'.repeat(70000)}),workspace)).status,400)
 assert.equal(writes,0)
})
test('receiver stores only hashes and a workspace; payload status and tenant fields grant no authority',async()=>{
 const body={status:'connected',clientId:randomUUID(),secret:'private correspondence'}
 const handler=createLinkedinWebhook(async(id,hash,payload)=>{
  assert.equal(id,workspace);assert.equal(hash,createHash('sha256').update(secret).digest('hex'))
  assert.match(payload,/^[a-f0-9]{64}$/);assert.ok(!payload.includes('private'));return true
 })
 assert.equal((await handler(request(body),workspace)).status,204)
 assert.equal((await createLinkedinWebhook(async()=>false)(request(),workspace)).status,401)
 assert.equal((await createLinkedinWebhook(async()=>{throw new Error('private')})(request(),workspace)).status,503)
})
const binding:RequestScan={campaign_id:randomUUID(),client_id:randomUUID(),remote_campaign_id:'10',workspace_id:workspace,workspace_version:1,remote_workspace_id:'20',credential_ref:'OUTREACH_HEYREACH_TEST',page_offset:0,started_at:new Date().toISOString(),failures:0,sender_ids:[randomUUID()],sender_versions:[1],remote_sender_ids:['30']}
const lead={linkedInSenderId:30,leadConnectionStatus:'ConnectionAccepted',leadMessageStatus:'None',linkedInUserProfile:{profileUrl:'https://linkedin.com/in/Test-Recipient/',firstName:'Test',lastName:'Recipient'}}
const metadata={id:10,organizationUnitId:20,campaignAccountIds:[30]}
const transport=(meta:unknown=metadata,items:unknown[]=[lead],totalCount=items.length):typeof fetch=>async(input,init)=>{
 const url=new URL(String(input));assert.ok(!/send|start|create|activate/i.test(url.pathname));
 if(url.pathname.endsWith('GetById'))return Response.json(meta)
 assert.equal(JSON.parse(String(init?.body)).timeFilter,'Everywhere')
 return Response.json({totalCount,items})
}
test('campaign and sender ownership are verified before accepting any observations',async()=>{
 for(const meta of [{...metadata,id:11},{...metadata,organizationUnitId:21},{...metadata,campaignAccountIds:[31]}, {...metadata,campaignAccountIds:[30,31]}]) await assert.rejects(readLinkedinRequestPage(binding,'synthetic',{fetch:transport(meta)}))
 await assert.rejects(readLinkedinRequestPage(binding,'synthetic',{fetch:transport(metadata,[{...lead,linkedInSenderId:31}])}))
 await assert.rejects(readLinkedinRequestPage(binding,'synthetic',{fetch:transport(metadata,[{...lead,linkedInSenderId:null}])}))
})
test('only explicit connection evidence establishes status; reply status alone does not invent requests',async()=>{
 const observation=await readLinkedinRequestPage(binding,'synthetic',{fetch:transport(metadata,[lead,{...lead,leadConnectionStatus:'None',leadMessageStatus:'MessageReply'}])})
 assert.deepEqual(observation.rows,[{senderId:binding.sender_ids[0],recipient:'https://www.linkedin.com/in/test-recipient',name:'Test Recipient',status:'connected'}])
 assert.equal(observation.nextOffset,null)
 assert.equal((await readLinkedinRequestPage(binding,'synthetic',{fetch:transport(metadata,[{...lead,leadMessageStatus:'MessageReply'}])})).rows[0].status,'replied')
 assert.equal((await readLinkedinRequestPage(binding,'synthetic',{fetch:transport(metadata,[{...lead,leadConnectionStatus:'ConnectionSent'}])})).rows[0].status,'sent')
})
test('pagination advances, inconsistent empty pages and invalid profiles fail closed',async()=>{
 assert.equal((await readLinkedinRequestPage(binding,'synthetic',{fetch:transport(metadata,[lead],101)})).nextOffset,1)
 await assert.rejects(readLinkedinRequestPage(binding,'synthetic',{fetch:transport(metadata,[],10)}))
 for(const profile of ['https://linkedin.com.evil.test/in/person','javascript:alert(1)','https://user:pass@linkedin.com/in/person','http://linkedin.com/in/person']) assert.equal(canonicalLinkedinProfile(profile),null)
})

test('campaign discovery accepts only campaigns entirely assigned to this workspace’s sender accounts',async()=>{
 const {scopedDiscoveredCampaigns}=await import('../../src/lib/linkedin-campaign-discovery')
 const campaign={id:10,organizationUnitId:20,campaignAccountIds:[30],name:'Synthetic',status:'IN_PROGRESS'}
 const result=scopedDiscoveredCampaigns({totalCount:4,items:[campaign,{...campaign,id:11,organizationUnitId:21},{...campaign,id:12,campaignAccountIds:[30,31]},{...campaign,id:13,campaignAccountIds:[]}]},'20',['30'])
 assert.equal(result.scoped.length,1);assert.equal(result.scoped[0].id,'10');assert.equal(result.scoped[0].status,'active')
})

test('unsigned notifications require an explicit server-side opt-in and never acquire authenticated authority',async()=>{
 const denied=createLinkedinWebhook(async(_id,hash)=>{assert.equal(hash,null);return false})
 assert.equal((await denied(request({},null),workspace)).status,401)
 const optedIn=createLinkedinWebhook(async(_id,hash,payload)=>{assert.equal(hash,null);assert.match(payload,/^[a-f0-9]{64}$/);return true})
 assert.equal((await optedIn(request({status:'connected',senderId:'untrusted'},null),workspace)).status,204)
})
