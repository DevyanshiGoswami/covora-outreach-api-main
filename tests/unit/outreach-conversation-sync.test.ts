import assert from 'node:assert/strict'
import test from 'node:test'
import { listScopedLinkedinConversations } from '../../src/lib/heyreach.ts'
import { syncLinkedinConversationPage } from '../../src/lib/outreach-conversation-sync.ts'
const sender={id:'11111111-1111-4111-8111-111111111111',remoteSenderId:'123',senderAddress:'https://www.linkedin.com/in/sender',senderLabel:'Your LinkedIn',campaigns:[{id:'22222222-2222-4222-8222-222222222222',remoteCampaignId:'42'}]}
const chat={id:'remote-thread',linkedInAccountId:123,groupChat:false,blockedByMe:false,blockedByParticipant:false,campaignId:42,lastMessageAt:'2026-10-03T12:00:00Z',correspondentProfile:{profileUrl:'https://www.linkedin.com/in/contact',firstName:'Sam',lastName:'Lee'},linkedInAccount:{id:123,authIsValid:true,profileUrl:sender.senderAddress},messages:[{createdAt:'2026-10-03T12:00:00Z',body:'Can we talk?',sender:null}]}
const options={apiKey:'test-key',fetch:async()=>Response.json({items:[chat],hasNextPage:false,nextCursor:null})}

test('sync consumes only the configured sender and forwards neutral fields with a stable private fingerprint',async()=>{
 const writes:unknown[]=[]
 const result=await syncLinkedinConversationPage(sender,null,options,async(row)=>{writes.push(row)})
 assert.deepEqual(result,{synced:1,nextCursor:null});assert.equal(writes.length,1)
 const row=writes[0] as Record<string,unknown>;assert.equal(row.senderId,sender.id);assert.equal(row.contactName,'Sam Lee');assert.equal(row.contactAddress,'https://www.linkedin.com/in/contact')
 const message=(row.messages as Array<Record<string,unknown>>)[0];assert.equal(message.direction,'received');assert.equal(message.bodyText,'Can we talk?');assert.match(message.fingerprint as string,/^[0-9a-f]{64}$/)
 assert.equal('linkedInAccount' in row,false)
})

test('foreign sender and repeated cursor fail before any mirror writes',async()=>{
 for(const response of [{items:[{...chat,linkedInAccountId:999}],hasNextPage:false,nextCursor:null},{items:[chat],hasNextPage:true,nextCursor:'same'}]){
  let writes=0
  await assert.rejects(syncLinkedinConversationPage(sender,'same',{...options,fetch:async()=>Response.json(response)},async()=>{writes++}))
  assert.equal(writes,0)
 }
})

test('personal and unmatched business conversations reject the whole page before any write',async()=>{
 for(const rejected of [{...chat,campaignId:undefined},{...chat,campaignId:99}]){
  let writes=0
  await assert.rejects(syncLinkedinConversationPage(sender,null,{...options,fetch:async()=>Response.json({items:[chat,rejected],hasNextPage:false,nextCursor:null})},async()=>{writes++}))
  assert.equal(writes,0)
 }
})
test('approved campaign group conversations are excluded',async()=>{
 let writes=0
 const result=await syncLinkedinConversationPage(sender,null,{...options,fetch:async()=>Response.json({items:[{...chat,groupChat:true}],hasNextPage:false,nextCursor:null})},async()=>{writes++})
 assert.equal(result.synced,0);assert.equal(writes,0)
})
test('zero approved LinkedIn campaigns makes no provider request',async()=>{
 let reads=0,writes=0
 const result=await syncLinkedinConversationPage({...sender,campaigns:[]},'old-cursor',{...options,fetch:async()=>{reads++;throw Error('must not read personal inbox')}},async()=>{writes++})
 assert.deepEqual(result,{synced:0,nextCursor:null});assert.equal(reads,0);assert.equal(writes,0)
})
test('invalid, duplicate or unsafe campaign IDs fail before provider reads',async()=>{
 for(const ids of [['0'],['42','42'],['042'],['9007199254740992'],['not-a-campaign']]){
  let reads=0
  await assert.rejects(listScopedLinkedinConversations('123',sender.senderAddress,ids,null,{...options,fetch:async()=>{reads++;return options.fetch()}}))
  assert.equal(reads,0)
 }
})

test('a page request binds the sender filter and bounded page size and rejects malformed history',async()=>{
 let request:Request|undefined
 await listScopedLinkedinConversations('123',sender.senderAddress,['42'],null,{...options,fetch:async(input,init)=>{request=new Request(input,init);return options.fetch()}})
 assert.equal(request!.url,'https://api.heyreach.io/api/public/inbox/GetConversationsV3')
 assert.deepEqual(await request!.json(),{limit:50,cursor:null,filters:{linkedInAccountIds:[123],campaignIds:[42]}})
 await assert.rejects(listScopedLinkedinConversations('123',sender.senderAddress,['42'],null,{...options,fetch:async()=>Response.json({items:[{...chat,messages:[{createdAt:'broken',body:'x',sender:null}]}],hasNextPage:false,nextCursor:null})}))
})
