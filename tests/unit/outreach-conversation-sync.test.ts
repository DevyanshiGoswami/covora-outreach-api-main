import assert from 'node:assert/strict'
import test from 'node:test'
import { listScopedLinkedinConversations } from '../../src/lib/heyreach.ts'
import { syncLinkedinConversationPage } from '../../src/lib/outreach-conversation-sync.ts'
const sender={id:'11111111-1111-4111-8111-111111111111',remoteSenderId:'123',senderAddress:'https://www.linkedin.com/in/sender',senderLabel:'Your LinkedIn'}
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

test('personal non-campaign and group conversations are excluded from agency sync',async()=>{
 const personal={...chat,campaignId:undefined};let writes=0
 const result=await syncLinkedinConversationPage(sender,null,{...options,fetch:async()=>Response.json({items:[personal,{...chat,id:'group',groupChat:true}],hasNextPage:false,nextCursor:null})},async()=>{writes++})
 assert.equal(result.synced,0);assert.equal(writes,0)
})

test('a page request binds the sender filter and bounded page size and rejects malformed history',async()=>{
 let request:Request|undefined
 await listScopedLinkedinConversations('123',sender.senderAddress,null,{...options,fetch:async(input,init)=>{request=new Request(input,init);return options.fetch()}})
 assert.equal(request!.url,'https://api.heyreach.io/api/public/inbox/GetConversationsV3')
 assert.deepEqual(await request!.json(),{limit:50,cursor:null,filters:{linkedInAccountIds:[123]}})
 await assert.rejects(listScopedLinkedinConversations('123',sender.senderAddress,null,{...options,fetch:async()=>Response.json({items:[{...chat,messages:[{createdAt:'broken',body:'x',sender:null}]}],hasNextPage:false,nextCursor:null})}))
})
