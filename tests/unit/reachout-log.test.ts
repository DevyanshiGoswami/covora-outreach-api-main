import assert from 'node:assert/strict'
import {test} from 'node:test'
import {reachoutLog,bindReachoutLog,traceReachout,providerValidationFields} from '../../src/lib/reachout-log'

test('request logs correlate safe metadata and never retain payloads or identifiers in paths',async()=>{
 const lines:string[]=[];const original=console.info;console.info=(...args)=>{lines.push(args.join(' '))}
 try {
  const id='10000000-0000-4000-8000-000000000001'
  const response=await traceReachout(new Request('https://api.example.test/api/outbound/reachout',{headers:{'x-covora-request-id':id}}),async()=>{
   bindReachoutLog({commandId:id,clientId:'private-key'})
   reachoutLog('delivery.rejected',{operation:'/accounts/private@example.test?token=private-key',status:400,code:'unsafe text private-key',fields:['firstName','Authorization: private-key']})
   return Response.json({ok:true})
  })
  assert.equal(response.headers.get('x-covora-request-id'),id)
  const text=lines.join('\n');assert.ok(text.includes(id));assert.ok(text.includes('/accounts/{email}'));assert.ok(text.includes('firstName'))
  assert.equal(text.includes('private-key'),false);assert.equal(text.includes('private@example.test'),false)
 }finally{console.info=original}
})
test('validation logging records field names only and bounds error bodies',async()=>{
 assert.deepEqual(await providerValidationFields(Response.json({errors:{firstName:['private note'],lastName:['secret']},api_key:'secret'})),['firstName','lastName'])
 assert.deepEqual(await providerValidationFields(new Response('x'.repeat(9000))),[])
})
