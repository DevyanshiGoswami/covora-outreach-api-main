import assert from 'node:assert/strict'
import test from 'node:test'
import { runLinkedinConversationBatch, type ConversationSyncBinding } from '../../src/lib/outreach-conversation-worker.ts'

const base: ConversationSyncBinding={id:'sender',clientId:'client',workspaceId:'workspace',workspaceVersion:1,version:1,credentialRef:'OUTREACH_HEYREACH_TEST',remoteSenderId:'123',senderAddress:'https://www.linkedin.com/in/sender',senderLabel:'Your LinkedIn',cursor:null}
function harness(bindings: ConversationSyncBinding[]) {
 const calls:string[]=[]
 return {calls, deps:{
  candidates:async()=>bindings, enabled:async()=>true,
  markAttempt:async(b:ConversationSyncBinding)=>{calls.push(`attempt:${b.id}`)},
  sync:async(b:ConversationSyncBinding,apiKey:string)=>{assert.equal(apiKey,'test-key');calls.push(`sync:${b.id}`);return {synced:1,nextCursor:'next'}},
  checkpoint:async(b:ConversationSyncBinding,next:string|null)=>{calls.push(`checkpoint:${b.id}:${next}`)},
  credentials:{OUTREACH_HEYREACH_TEST:'test-key'},timeLeft:()=>15000,
 }}
}
test('one bounded sync page per sender checkpoints only after saving and rotates visits',async()=>{
 const h=harness([base,{...base,id:'second'}]);const result=await runLinkedinConversationBatch(h.deps)
 assert.deepEqual(result,{senders:2,conversations:2,failed:0,deferred:0})
 assert.deepEqual(h.calls,['attempt:sender','sync:sender','checkpoint:sender:next','attempt:second','sync:second','checkpoint:second:next'])
})
test('missing keys, disabled feature and time budget prevent provider access',async()=>{
 for(const patch of [{credentials:{}},{enabled:async()=>false},{timeLeft:()=>500}]){
  const h=harness([base]);await runLinkedinConversationBatch({...h.deps,...patch});assert.equal(h.calls.some(c=>c.startsWith('sync:')),false)
 }
})
test('failed page retains cursor and cannot starve the next sender',async()=>{
 const h=harness([base,{...base,id:'second'}]);const normal=h.deps.sync
 h.deps.sync=async(b,key)=>{if(b.id==='sender')throw new Error('private provider error');return normal(b,key)}
 const result=await runLinkedinConversationBatch(h.deps)
 assert.equal(result.failed,1);assert.equal(result.senders,1);assert.equal(h.calls.includes('checkpoint:sender:next'),false);assert.equal(h.calls.includes('checkpoint:second:next'),true)
})
test('batch bound and deadline prevent an unbounded tenant scan',async()=>{
 const h=harness(Array.from({length:20},(_,i)=>({...base,id:String(i)})));await runLinkedinConversationBatch(h.deps)
 assert.equal(h.calls.filter(c=>c.startsWith('sync:')).length,3)
})
