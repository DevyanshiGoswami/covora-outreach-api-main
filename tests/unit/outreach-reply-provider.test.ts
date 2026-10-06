import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareOutreachReply, sendOutreachReply, type ReplyProviderContext } from '../../src/lib/outreach-reply-provider.ts'
import { linkedinMessageFingerprint } from '../../src/lib/heyreach.ts'

const W='11111111-1111-4111-8111-111111111111', C='22222222-2222-4222-8222-222222222222', T='33333333-3333-4333-8333-333333333333', M='44444444-4444-4444-8444-444444444444'
const context:ReplyProviderContext={channel:'email',credentialRef:'OUTREACH_INSTANTLY_TEST',remoteWorkspaceId:W,remoteSenderId:'sender@example.test',senderAddress:'sender@example.test',remoteConversationId:T,remoteReplyToId:M,remoteLatestMessageId:M,remoteCampaignId:C,contactAddress:'lead@example.test',latestMessageFingerprint:null,subject:'Re: A question',bodyText:'Hello there'}
const credentials={OUTREACH_INSTANTLY_TEST:'private-test-key',OUTREACH_HEYREACH_TEST:'private-linkedin-key'}
const email={id:M,organization_id:W,eaccount:context.senderAddress,thread_id:T,campaign_id:C,lead:context.contactAddress,from_address_email:context.contactAddress,to_address_email_list:context.senderAddress,ue_type:2}
const account={email:context.senderAddress,organization:W,status:1,setup_pending:false}
function harness(items: Array<unknown|Response|Error>) {
 const calls:Request[]=[]
 const fetcher:typeof fetch=async(input,init)=>{calls.push(new Request(input,init));const item=items.shift();assert.notEqual(item,undefined,'unexpected request');if(item instanceof Error)throw item;return item instanceof Response?item:Response.json(item)}
 return {calls,options:{credentials,repliesEnabled:true,fetch:fetcher}}
}
function emailReads(overrides:Record<string,unknown>={}){return [{id:W},account,{...email,...overrides},{items:[email]}]}

test('email reply preflight pins workspace, connected sender, target recipient, campaign and latest thread before one dispatch',async()=>{
 const h=harness([...emailReads(),{...email,id:'55555555-5555-4555-8555-555555555555',ue_type:3,from_address_email:context.senderAddress,to_address_email_list:context.contactAddress}])
 const result=await prepareOutreachReply(context,h.options);assert.equal(result.ok,true);if(!result.ok)return
 assert.equal(h.calls.every(r=>r.method==='GET'),true)
 const sent=await sendOutreachReply(result.prepared,h.options);assert.equal(sent.status,'sent')
 assert.equal(h.calls.length,5)
 const request=h.calls.at(-1)!;assert.equal(new URL(request.url).pathname,'/api/v2/emails/reply');assert.equal(request.method,'POST')
 assert.deepEqual(await request.json(),{eaccount:context.senderAddress,reply_to_uuid:M,subject:context.subject,body:{text:'Hello there'}})
 for(const request of h.calls){assert.equal(new URL(request.url).origin,'https://api.instantly.ai');assert.equal(request.redirect,'error');assert.equal(request.cache,'no-store')}
 assert.equal((await sendOutreachReply(result.prepared,h.options)).status,'failed');assert.equal(h.calls.length,5,'a prepared reply is consumed once')
})

test('wrong workspace, mailbox, participant, direction or latest message refuses dispatch',async()=>{
 for(const [items,expected] of [
  [[{id:C}],'identity_mismatch'],
  [[{id:W},{...account,email:'other@example.test'}],'identity_mismatch'],
  [emailReads({from_address_email:'other@example.test'}),'identity_mismatch'],
  [emailReads({ue_type:3}),'identity_mismatch'],
  [emailReads({campaign_id:W}),'identity_mismatch'],
  [[{id:W},account,email,{items:[{...email,id:W}]}],'changed'],
 ] as const){const h=harness([...items]);const value=await prepareOutreachReply(context,h.options);assert.deepEqual(value,{ok:false,reason:expected});assert.equal(h.calls.some(r=>r.method==='POST'),false)}
})

test('missing dedicated credentials and malformed body never use the legacy key or touch the network',async()=>{
 const h=harness([])
 assert.equal((await prepareOutreachReply(context,{...h.options,credentials:{INSTANTLY_API_KEY:'legacy'}})).ok,false)
 assert.equal((await prepareOutreachReply({...context,bodyText:' '},h.options)).ok,false)
 assert.equal(h.calls.length,0)
})

test('ambiguous replies are unknown and never retried; explicit rejection is failed',async()=>{
 for(const [response,status] of [[new Error('secret'), 'unknown'],[new Response('',{status:500}),'unknown'],[Response.json({private:'secret'}),'unknown'],[new Response('',{status:429}),'failed'],[new Response('',{status:403}),'failed']] as const){
  const h=harness([...emailReads(),response]);const prepared=await prepareOutreachReply(context,h.options);assert.equal(prepared.ok,true);if(!prepared.ok)continue
  assert.equal((await sendOutreachReply(prepared.prepared,h.options)).status,status);assert.equal(h.calls.length,5)
 }
})

const liMessage={createdAt:'2026-10-03T12:00:00Z',body:'Interested',sender:null}
const liContext:ReplyProviderContext={...context,channel:'linkedin',credentialRef:'OUTREACH_HEYREACH_TEST',remoteWorkspaceId:'test-workspace',remoteSenderId:'123',senderAddress:'https://www.linkedin.com/in/sender',remoteConversationId:'thread/123',remoteReplyToId:null,remoteLatestMessageId:null,remoteCampaignId:null,contactAddress:'https://www.linkedin.com/in/contact',latestMessageFingerprint:linkedinMessageFingerprint(liMessage),subject:'',bodyText:'Thanks for your interest'}
const chat={id:liContext.remoteConversationId,linkedInAccountId:123,groupChat:false,blockedByMe:false,blockedByParticipant:false,lastMessageAt:liMessage.createdAt,correspondentProfile:{profileUrl:liContext.contactAddress},linkedInAccount:{id:123,authIsValid:true,profileUrl:liContext.senderAddress},messages:[liMessage]}
const liAccount={id:123,isActive:false,authIsValid:true,profileUrl:liContext.senderAddress}
const liStatus={accountId:123,status:'Connected',failureReason:null,profile:{profileUrl:liContext.senderAddress}}
function linkedinReads(patch:Record<string,unknown>={}){return [liAccount,liStatus,{...chat,...patch}]}

test('global sending gate blocks preparation and is rechecked before an already prepared send',async()=>{
 const blocked=harness([])
 assert.deepEqual(await prepareOutreachReply(liContext,{...blocked.options,repliesEnabled:false}),{ok:false,reason:'unavailable'})
 assert.equal(blocked.calls.length,0)
 const h=harness(linkedinReads())
 const result=await prepareOutreachReply(liContext,h.options)
 assert.equal(result.ok,true);if(!result.ok)return
 assert.deepEqual(await sendOutreachReply(result.prepared,{...h.options,repliesEnabled:false}),{status:'failed',remoteMessageId:null})
 assert.equal(h.calls.length,3)
 assert.deepEqual(await sendOutreachReply(result.prepared,h.options),{status:'failed',remoteMessageId:null})
 assert.equal(h.calls.length,3)
})

test('LinkedIn replies accept a connected idle sender and validate its account status and conversation before one dispatch',async()=>{
 const h=harness([...linkedinReads(),new Response('',{status:200})])
 const result=await prepareOutreachReply(liContext,h.options);assert.equal(result.ok,true);if(!result.ok)return
 assert.deepEqual(await sendOutreachReply(result.prepared,h.options),{status:'sent',remoteMessageId:null})
 assert.equal(h.calls.length,4);const request=h.calls[3]
 assert.equal(new URL(request.url).origin,'https://api.heyreach.io');assert.deepEqual(await request.json(),{linkedInAccountId:123,conversationId:'thread/123',message:liContext.bodyText,subject:''})
 assert.equal(h.calls[2].url.includes('thread%2F123'),true)
 assert.deepEqual(h.calls.slice(0,3).map(r=>new URL(r.url).pathname),['/api/public/li_account/GetById','/api/public/li_account/GetAccountStatus/123','/api/public/inbox/GetChatroom/123/thread%2F123'])
 for(const request of h.calls.slice(0,3)){assert.equal(request.method,'GET');assert.equal(request.headers.get('X-API-KEY'),credentials.OUTREACH_HEYREACH_TEST);assert.equal(request.redirect,'error');assert.equal(request.cache,'no-store')}
 assert.equal((await sendOutreachReply(result.prepared,h.options)).status,'failed');assert.equal(h.calls.length,4,'LinkedIn preparation is consumed once')
})

test('LinkedIn connection status is required regardless of isActive and malformed or contradictory observations fail closed',async()=>{
 for(const status of [
  {...liStatus,status:'Disconnected'}, {...liStatus,status:'Connecting'}, {...liStatus,status:'Syncing'},
  {...liStatus,status:'PinRequired'}, {...liStatus,status:'NewProviderStatus'}, {...liStatus,status:'connected'},
  {...liStatus,failureReason:'Authentication failed'}, {...liStatus,failureReason:false},
  {...liStatus,accountId:'123'}, {...liStatus,accountId:undefined}, {...liStatus,status:undefined}, null,
 ]){
  const h=harness([{...liAccount,isActive:true},status])
  assert.deepEqual(await prepareOutreachReply(liContext,h.options),{ok:false,reason:'unavailable'})
  assert.equal(h.calls.length,2);assert.equal(h.calls.every(r=>r.method==='GET'),true)
 }
})

test('LinkedIn status identity cannot replace the exact authenticated sender and profile',async()=>{
 for(const [account,status,count] of [
  [{...liAccount,authIsValid:false},liStatus,1],
  [{...liAccount,id:456},liStatus,1],
  [{...liAccount,profileUrl:'https://www.linkedin.com/in/other'},liStatus,1],
  [liAccount,{...liStatus,accountId:456},2],
  [liAccount,{...liStatus,profile:{profileUrl:'https://www.linkedin.com/in/other'}},2],
 ] as const){
  const h=harness([account,status])
  const result=await prepareOutreachReply(liContext,h.options)
  assert.equal(result.ok,false);assert.equal(h.calls.length,count);assert.equal(h.calls.every(r=>r.method==='GET'),true)
 }
})

test('LinkedIn status failures never fall back to account flags, read history or send',async()=>{
 for(const status of [new Response('',{status:401}),new Response('',{status:429}),new Response('',{status:503}),new Response('not json'),new Error('private-key')]){
  const h=harness([{...liAccount,isActive:true},status])
  assert.deepEqual(await prepareOutreachReply(liContext,h.options),{ok:false,reason:'unavailable'})
  assert.equal(h.calls.length,2);assert.equal(h.calls.every(r=>r.method==='GET'),true)
 }
})

test('LinkedIn status read shares the preparation deadline and aborts without retry or dispatch',async()=>{
 let reads=0,aborted=false
 const result=await prepareOutreachReply(liContext,{credentials,repliesEnabled:true,timeoutMs:15,fetch:async(input,init)=>{
  reads++
  if(reads===1)return Response.json(liAccount)
  assert.equal(new URL(String(input)).pathname,'/api/public/li_account/GetAccountStatus/123')
  return await new Promise<Response>((resolve,reject)=>{
   const timer=setTimeout(()=>resolve(Response.json(liStatus)),150)
   init!.signal!.addEventListener('abort',()=>{aborted=true;clearTimeout(timer);reject(new Error('status timed out'))},{once:true})
  })
 }})
 assert.deepEqual(result,{ok:false,reason:'unavailable'});assert.equal(reads,2);assert.equal(aborted,true)
})

test('LinkedIn group, blocked, wrong sender, changed history and unknown sender values are rejected',async()=>{
 for(const patch of [{groupChat:true},{blockedByParticipant:true},{linkedInAccountId:456},{correspondentProfile:{profileUrl:'https://www.linkedin.com/in/other'}},{messages:[{...liMessage,body:'New message'}]},{messages:[{...liMessage,sender:'UNKNOWN'}]}]){
  const h=harness(linkedinReads(patch));assert.equal((await prepareOutreachReply(liContext,h.options)).ok,false);assert.equal(h.calls.length,3)
 }
})

test('cancelled preparation performs no read and forged preparation cannot send',async()=>{
 const h=harness([]);assert.equal((await prepareOutreachReply(context,{...h.options,signal:AbortSignal.abort()})).ok,false)
 assert.equal((await sendOutreachReply({context,preparedAt:Date.now()},h.options)).status,'failed');assert.equal(h.calls.length,0)
})

test('provider timeout returns unknown once without leaving a hanging request or a retry',async()=>{
 const h=harness(emailReads());const prepared=await prepareOutreachReply(context,h.options);assert.equal(prepared.ok,true);if(!prepared.ok)return
 let writes=0,aborted=false
 const result=await sendOutreachReply(prepared.prepared,{...h.options,timeoutMs:10,fetch:async(_input,init)=>{
  writes++;return await new Promise<Response>((resolve,reject)=>{
   const timer=setTimeout(()=>resolve(Response.json(email)),150)
   init!.signal!.addEventListener('abort',()=>{aborted=true;clearTimeout(timer);reject(new Error('transport timed out'))},{once:true})
  })
 }})
 assert.deepEqual(result,{status:'unknown',remoteMessageId:null});assert.equal(writes,1);assert.equal(aborted,true)
})

test('credential rotation between preparation and dispatch prevents any send',async()=>{
 const h=harness(emailReads());const result=await prepareOutreachReply(context,h.options);assert.equal(result.ok,true);if(!result.ok)return
 assert.equal((await sendOutreachReply(result.prepared,{...h.options,credentials:{OUTREACH_INSTANTLY_TEST:'new-key'}})).status,'failed')
 assert.equal(h.calls.length,4)
})

test('LinkedIn rejection and timeout are not shown as accepted and do not retry',async()=>{
 for(const [response,status] of [[new Error('private-key'),'unknown'],[new Response('',{status:503}),'unknown'],[new Response('',{status:403}),'failed']] as const){
  const h=harness([...linkedinReads(),response])
  const prepared=await prepareOutreachReply(liContext,h.options);assert.equal(prepared.ok,true);if(!prepared.ok)continue
  assert.equal((await sendOutreachReply(prepared.prepared,h.options)).status,status);assert.equal(h.calls.length,4)
  assert.equal((await sendOutreachReply(prepared.prepared,h.options)).status,'failed');assert.equal(h.calls.length,4)
 }
})

test('unexpected nonempty LinkedIn HTTP200 body never becomes a false accepted receipt',async()=>{
 const h=harness([...linkedinReads(),Response.json({error:'ambiguous'})])
 const prepared=await prepareOutreachReply(liContext,h.options);assert.equal(prepared.ok,true);if(!prepared.ok)return
 assert.deepEqual(await sendOutreachReply(prepared.prepared,h.options),{status:'unknown',remoteMessageId:null});assert.equal(h.calls.length,4)
})

test('LinkedIn equal-time messages use the same deterministic fingerprint order as the mirror',async()=>{
 const messages=[liMessage,{...liMessage,body:'A second message'}].sort((a,b)=>linkedinMessageFingerprint(a).localeCompare(linkedinMessageFingerprint(b)))
 const expected=linkedinMessageFingerprint(messages[1])
 const h=harness(linkedinReads({messages}))
 assert.equal((await prepareOutreachReply({...liContext,latestMessageFingerprint:expected},h.options)).ok,true)
})
