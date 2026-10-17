import assert from 'node:assert/strict'
import test from 'node:test'
import { createOutboundEscrowLeadHandlers } from '../../src/lib/outbound-escrow-leads-api.ts'

const CLIENT = 'c5ddfa59-1551-4688-a381-10d94107140f'
const USER = 'f0d5c941-2898-4f66-a7bb-51e68443517e'
const LEAD = '9d375705-20e1-4c5e-a0af-be175888827f'
const LIST = '5a3f2313-a651-4c74-ae2f-ec6a0fc8e86c'
const user = { id: USER, aud: 'authenticated', role: 'authenticated', email: 'operator@example.test', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-10-03T00:00:00Z' }
const lead = { id: LEAD, clientId: CLIENT, campaignId: null, campaignName: null, listId: LIST, listName: 'Research queue', firstName: 'Jane', lastName: 'Sample', fullName: 'Jane Sample', company: 'Acme', jobTitle: 'Director', location: null, email: 'jane@example.test', emailVerification: 'unknown', linkedinUrl: null, linkedinVerified: null, status: 'not_contacted', interest: null, lastActivityAt: null, reviewState: 'escrow', reviewReason: 'Needs investigation.', reviewedAt: '2026-10-17T18:00:00Z', priorityRank: null }
const page = { clientId: CLIENT, leads: [lead], total: 1, page: 1, pageSize: 36, summary: { escrow: 1, clientVisible: 1000 } }
function request(query=`clientId=${CLIENT}`,authorization='Bearer synthetic-token') {
  return new Request(`https://backend.invalid/api/outbound/leads/escrow?${query}`,{headers:{authorization}})
}
function harness(result:unknown=page,status=200,authStatus=200) {
  const calls:{path:string;body:string;headers:Headers;cache:RequestCache}[]=[]
  const handlers=createOutboundEscrowLeadHandlers({url:'https://db.invalid',anonKey:'public-key',fetch:async(input,init)=>{
    const req=new Request(input,init),path=new URL(req.url).pathname
    calls.push({path,body:await req.text(),headers:req.headers,cache:req.cache})
    if(path==='/auth/v1/user')return Response.json(authStatus===200?user:{error:'private auth detail'},{status:authStatus})
    assert.equal(path,'/rest/v1/rpc/list_outreach_escrow_leads')
    return Response.json(result,{status})
  }})
  return {handlers,calls}
}

test('escrow GET delegates authority to a user-bound RPC and strips private evidence',async()=>{
  const {handlers,calls}=harness({...page,secret:'never',leads:[{...lead,review_evidence:{secret:'never'}}]})
  const response=await handlers.GET(request())
  assert.equal(response.status,200)
  assert.deepEqual(await response.json(),page)
  assert.equal(response.headers.get('cache-control'),'no-store')
  assert.equal(response.headers.get('vary'),'Authorization')
  assert.deepEqual(calls.map(r=>r.path),['/auth/v1/user','/rest/v1/rpc/list_outreach_escrow_leads'])
  assert.deepEqual(JSON.parse(calls[1].body),{p_client_id:CLIENT,p_q:'',p_page:1})
  for(const call of calls){assert.equal(call.headers.get('authorization'),'Bearer synthetic-token');assert.equal(call.headers.get('apikey'),'public-key');assert.equal(call.cache,'no-store')}
})

test('escrow API rejects broadening filters and malformed pagination before RPC',async()=>{
  for(const query of ['',`clientId=${CLIENT}&visibility=client`,`clientId=${CLIENT}&clientId=${CLIENT}`,`clientId=${CLIENT}&page=0`,`clientId=${CLIENT}&page=01`,`clientId=${CLIENT}&page=1000001`,`clientId=${CLIENT}&q=${'x'.repeat(201)}`]){
    const {handlers,calls}=harness()
    assert.equal((await handlers.GET(request(query))).status,400)
    assert.equal(calls.length,1)
  }
  const {handlers,calls}=harness()
  assert.equal((await handlers.GET(request(undefined,''))).status,401)
  assert.equal(calls.length,0)
  const denied=harness(undefined,200,401)
  assert.equal((await denied.handlers.GET(request())).status,401)
  assert.equal(denied.calls.length,1)
})

test('escrow API honors role denial and never exposes RPC diagnostics',async()=>{
  for(const [code,status] of [['42501',403],['22023',400],['XX000',500]] as const){
    const {handlers}=harness({code,message:'private customer records'},400)
    const response=await handlers.GET(request())
    assert.equal(response.status,status)
    assert.doesNotMatch(await response.text(),/private customer/)
  }
})

test('escrow API fails closed on foreign, client-visible or malformed rows and count mismatches',async()=>{
  for(const result of [
    {...page,clientId:USER},{...page,leads:[{...lead,clientId:USER}]},
    {...page,leads:[{...lead,reviewState:'client'}]},{...page,leads:[{...lead,priorityRank:1}]},
    {...page,leads:[{...lead,campaignId:USER}]},{...page,leads:[{...lead,reviewReason:null}]},
    {...page,leads:[lead,lead]},{...page,total:2},{...page,summary:{escrow:0,clientVisible:1000}},
    {...page,page:2},{...page,pageSize:100},
    {...page,leads:[{...lead,sourceUrls:['javascript:bad']}]},
    {...page,leads:[{...lead,emailValidation:'verified'}]},
  ]){
    const {handlers}=harness(result)
    const response=await handlers.GET(request())
    assert.equal(response.status,500)
    assert.doesNotMatch(await response.text(),/jane@example|Acme|javascript/)
  }
})

test('escrow search keeps total inventory separate and accepts last-page clamping',async()=>{
  const {handlers,calls}=harness({...page,summary:{escrow:500,clientVisible:1000}})
  const response=await handlers.GET(request(`clientId=${CLIENT}&q=%20Jane%20&page=1000000`))
  assert.equal(response.status,200)
  assert.deepEqual(JSON.parse(calls[1].body),{p_client_id:CLIENT,p_q:'Jane',p_page:1000000})
  const empty=harness({...page,leads:[],total:0,summary:{escrow:0,clientVisible:2}})
  assert.equal((await empty.handlers.GET(request())).status,200)
})
