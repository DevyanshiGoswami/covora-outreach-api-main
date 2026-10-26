import assert from 'node:assert/strict'
import test from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { scopedDataQuery } from '../../src/lib/developer-data'
import { authorizeDevelopmentRequest } from '../../src/lib/developer-scope'
import { type DeveloperSession } from '../../src/lib/developer-session'
const id = '10000000-0000-4000-8000-000000000001'
const other = '10000000-0000-4000-8000-000000000002'
const scope: DeveloperSession = { clientId:id, userId:other,email:'owner@example.test',clientName:'Covora',expiresAt:new Date(Date.now()+60000).toISOString(),bearer:'synthetic-upstream-bearer' }
test('neutral queries force Covora scope and reject embeds, schemas, RPCs, OR and tenant overrides', () => {
 const base = 'https://gateway.example.test/api/development/data?'
 const accepted = scopedDataQuery(new URL(base+'resource=client_outreach_workspaces&select=client_id,client_name,role&order=client_name.asc&offset=0&limit=500'),id)
 assert.equal(accepted.query.get('client_id'),`eq.${id}`)
 for (const suffix of [
  'resource=clients&select=id', 'resource=client_outreach_workspaces&select=*',
  'resource=client_outreach_workspaces&select=client_id,clients(*)',
  'resource=client_outreach_workspaces&select=client_id&or=(client_id.neq.bad)',
  `resource=client_outreach_workspaces&select=client_id&client_id=eq.${other}`,
  `resource=client_outreach_workspaces&select=client_id&client_id=eq.${id}&client_id=eq.${other}`,
  'resource=client_outreach_workspaces&select=client_id&limit=1001',
  'resource=client_outreach_workspaces&select=client_id&resource=clients',
  'resource=client_outreach_workspaces&select=count()',
  'resource=client_outreach_workspaces&select=client_id&clients.id=eq.any',
  'resource=client_outreach_workspaces&select=client_id&select=client_name',
  'resource=client_outreach_workspaces&select=client_id&limit=1&limit=500',
  'resource=client_outreach_workspaces&select=client_id&offset=0&offset=1',
  'resource=client_outreach_workspaces&select=client_id&order=client_name&order=role',
  'resource=client_outreach_campaign_daily&select=day&day=gte.2026-10-01&day=not.is.null',
 ]) assert.throws(()=>scopedDataQuery(new URL(base+suffix),id),suffix)
})
test('the portal SDK date window preserves both daily bounds and forced client scope', async () => {
 let checked = false
 const db = createClient('https://database.example.test','synthetic-public-key',{
  auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(input)=>{
   const url = new URL(String(input));url.searchParams.set('resource','client_outreach_campaign_daily')
   const scoped = scopedDataQuery(url,id)
   assert.deepEqual(scoped.query.getAll('day'),['lte.2026-10-26','gte.2026-09-27'])
   assert.deepEqual(scoped.query.getAll('client_id'),[`eq.${id}`])
   assert.equal(scoped.query.get('limit'),'500');checked=true
   return Response.json([])
  }},
 })
 const result = await db.from('client_outreach_campaign_daily').select('campaign_id,day,sent')
  .eq('client_id',id).lte('day','2026-10-26').gte('day','2026-09-27')
  .order('day',{ascending:false}).order('campaign_id').range(0,499)
 assert.ifError(result.error);assert.equal(checked,true)
})
test('API allowlist binds both reads and writes and denies future or global endpoints', async () => {
 const req=(path:string,method='GET',body?:unknown)=>new Request('https://gateway.example.test'+path,{method,headers:{'Content-Type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})})
 await authorizeDevelopmentRequest(req(`/api/outbound/accounts?clientId=${id}`),scope)
 await authorizeDevelopmentRequest(req('/api/outbound/conversations/'+other+'/reply','POST',{clientId:id}),scope)
 for(const request of [
  req(`/api/outbound/accounts?clientId=${other}`),req(`/api/outbound/accounts?clientId=${id}&clientId=${other}`),
  req('/api/outbound/accounts','POST',{clientId:other}), req('/api/outbound/accounts','DELETE',{clientId:id}),
  req('/api/outbound/future?clientId='+id),req('/api/onboarding/admin-integrations'),req('/api/outbound/owners'),
  req('/api/onboarding/clients/remove','POST',{clientId:id}), req('/api/onboarding/integrations','POST',{clientId:id}),
  req('/api/outbound/invitations/accept','POST',{clientId:id}),
 ]) await assert.rejects(()=>authorizeDevelopmentRequest(request,scope))
})

test('oversized streamed bodies are refused without waiting for a cloned branch', { timeout:2000 }, async()=>{
 const request=new Request('https://gateway.example.test/api/outbound/accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"clientId":"'+id+'","padding":"'+'x'.repeat(9000)+'"}'})
 await assert.rejects(()=>authorizeDevelopmentRequest(request,scope),{status:400})
 await request.body?.cancel()
})
