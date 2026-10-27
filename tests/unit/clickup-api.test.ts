import test from 'node:test'
import assert from 'node:assert/strict'
import { clickUpSettings, exchangeClickUpCode, type ClickUpConfig } from '../../src/lib/clickup-api'
const settings={clientId:'app-id',clientSecret:'synthetic-secret',redirectUri:'https://covora.app/auth/clickup/callback'}
test('OAuth settings require an exact callback path and safe origin',()=>{
 const config={...settings,url:'https://db.invalid',anonKey:'anon',serviceKey:'service',fetch} as ClickUpConfig
 assert.deepEqual(clickUpSettings(config),settings)
 for(const redirectUri of ['https://covora.app/other','https://user:password@covora.app/auth/clickup/callback','https://covora.app/auth/clickup/callback?next=evil','http://evil.test/auth/clickup/callback'])assert.equal(clickUpSettings({...config,redirectUri}),null)
 assert.equal(clickUpSettings({...config,clientSecret:undefined}),null)
})
test('code exchange uses fixed endpoints, no redirects or caching and strips workspace membership data',async()=>{
 let calls=0
 const result=await exchangeClickUpCode('synthetic-code',settings,async(input,init)=>{
  calls++; assert.equal(init?.cache,'no-store');assert.equal(init?.redirect,'error'); assert.ok(init?.signal)
  if(calls===1){assert.equal(input,'https://api.clickup.com/api/v2/oauth/token');assert.deepEqual(JSON.parse(String(init?.body)),{client_id:'app-id',client_secret:'synthetic-secret',code:'synthetic-code'}); return Response.json({access_token:'synthetic-token'})}
  assert.equal(input,'https://api.clickup.com/api/v2/team'); assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-token')
  return Response.json({teams:[{id:'123',name:'Test Workspace',members:[{private:'discard'}]}]})
 })
 assert.deepEqual(result,{token:'synthetic-token',workspaces:[{id:'123',name:'Test Workspace'}]})
 assert.equal(calls,2)
})
test('failed exchanges and empty or malformed grants are never accepted',async()=>{
 let calls=0
 await assert.rejects(exchangeClickUpCode('code',settings,async()=>{calls++;return Response.json({error:'secret diagnostics'},{status:401})})); assert.equal(calls,1)
 for(const teams of [[],[{id:'123',name:'Test'},{id:'123',name:'Duplicate'}],[{id:'123'}]]) {
  calls=0; await assert.rejects(exchangeClickUpCode('code',settings,async()=>++calls===1?Response.json({access_token:'synthetic-token'}):Response.json({teams})))
 }
})
test('app credentials reject whitespace and oversized values',()=>{
 for(const change of [{clientId:'bad id'},{clientSecret:'short'},{clientSecret:'line\nbreak'},{clientId:'x'.repeat(201)}])assert.equal(clickUpSettings({...settings,...change}),null)
})
