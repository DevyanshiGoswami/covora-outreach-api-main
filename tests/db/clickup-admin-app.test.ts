import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createTenant, createAdmin } from '../helpers/tenants'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach'
import { adminClient } from '../helpers/admin'
import { loadTestEnv } from '../helpers/env'
import { testDatabaseContainer } from '../helpers/stack'
import { createClickUpAdminHandlers } from '../../src/lib/clickup-admin-api'
import { createClickUpHandlers } from '../../src/lib/clickup-api'
import { loadClickUpSettings } from '../../src/lib/clickup-settings'

test('app credentials: owner authorization, encrypted storage, safe metadata, rotation races and disable',async t=>{
 const owner=await createAdmin(t),tenant=await createTenant(t,{features:['outreach_app']})
 await grantOutreachOwner(owner.user.id);await grantOutreachMembership(tenant.user.id,tenant.client.id)
 const env=loadTestEnv(),admin=adminClient(),redirectUri='https://covora.app/auth/clickup/callback'
 let exchangeHook:undefined|(()=>Promise<void>)
 const config={url:env.URL,anonKey:env.ANON,serviceKey:env.SERVICE,fetch,redirectUri,providerFetch:async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  if(String(input).endsWith('/oauth/token')) {
   const body=JSON.parse(String(init?.body));assert.equal(body.client_id,'synthetic-app');assert.equal(body.client_secret,'synthetic-secret')
   await exchangeHook?.();return Response.json({access_token:'synthetic-client-token'})
  }
  return Response.json({teams:[{id:'private-team',name:'Test Workspace'}]})
 }}
 const handlers=createClickUpAdminHandlers(config),clients=createClickUpHandlers(config)
 const token=(await owner.supabase.auth.getSession()).data.session!.access_token,clientToken=(await tenant.supabase.auth.getSession()).data.session!.access_token
 const request=(body?:object,bearer=token)=>new Request('https://backend.invalid/api/onboarding/clickup-app',{method:body?'POST':'GET',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
 const cr=(body?:object)=>new Request(`https://backend.invalid/api/outbound/clickup${body?'':`?clientId=${tenant.client.id}`}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${clientToken}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
 const save={action:'save',version:0,clientId:'synthetic-app',clientSecret:'synthetic-secret'}
 const begin=async()=>{const browserProof=randomBytes(32).toString('base64url');const r=await clients.POST(cr({action:'start',clientId:tenant.client.id,browserProof}));assert.equal(r.status,200,await r.clone().text());return {...await r.json(),browserProof}}
 const complete=(a:{state:string;browserProof:string})=>clients.POST(cr({action:'complete',clientId:tenant.client.id,state:a.state,browserProof:a.browserProof,code:'synthetic-code'}))
 t.after(()=>execFileSync('docker',['exec',testDatabaseContainer,'psql','-U','postgres','-d','postgres','-c',"do $$ declare s uuid; begin select secret_id into s from public.outreach_clickup_app; update public.outreach_clickup_app set secret_id=null,client_id=null,redirect_uri=null,version=0,updated_at=null,updated_by=null; delete from vault.secrets where id=s; end $$;"],{stdio:'pipe'}))
 assert.equal((await handlers.GET(request(undefined,clientToken))).status,403)
 assert.equal((await handlers.POST(request(save,clientToken))).status,403)
 assert.equal((await handlers.GET(request(undefined,'invalid'))).status,401)
 for(const session of [owner.supabase,tenant.supabase]) {
  assert.equal((await session.rpc('read_outreach_clickup_app')).error?.code,'42501')
  assert.equal((await session.from('outreach_clickup_app').select('*')).error?.code,'42501')
  assert.equal((await session.rpc('save_outreach_clickup_app',{p_actor:owner.user.id,p_actor_version:1,p_version:0,p_client_id:'forged',p_secret:'forged-secret',p_redirect_uri:redirectUri})).error?.code,'42501')
 }
 assert.equal((await handlers.POST(request({...save,redirectUri:'https://evil.test/auth/clickup/callback'}))).status,400)
 assert.equal((await handlers.POST(request(save))).status,200)
 assert.equal((await handlers.POST(request(save))).status,400)
 const metadata=await (await handlers.GET(request())).text()
 for(const secret of ['synthetic-secret','synthetic-app','secret_id'])assert.ok(!metadata.includes(secret))
 assert.equal(JSON.parse(metadata).configured,true);assert.equal(JSON.parse(metadata).version,1)
 assert.equal((await loadClickUpSettings(config)).settings?.clientSecret,'synthetic-secret')
 assert.equal((await (await clients.GET(cr())).json()).configured,true)
 const pending=await begin();assert.equal(new URL(pending.authorizationUrl).searchParams.get('client_id'),'synthetic-app')
 assert.equal((await handlers.POST(request({...save,version:1}))).status,200)
 assert.equal((await complete(pending)).status,403)
 assert.equal((await complete(await begin())).status,200)
 assert.equal((await handlers.POST(request({...save,version:2,clientId:'different-app'}))).status,400)
 const race=await begin()
 exchangeHook=async()=>{assert.equal((await handlers.POST(request({...save,version:2}))).status,200)}
 assert.equal((await complete(race)).status,403);exchangeHook=undefined
 const status=await (await clients.GET(cr())).json();assert.equal(status.connected,true);assert.equal(status.version,1)
 const stored=await admin.from('outreach_clickup_app').select('secret_id').single();assert.ok(stored.data?.secret_id)
 const actor=await admin.from('outreach_agency_memberships').select('version').eq('user_id',owner.user.id).single()
 assert.ifError((await admin.from('outreach_agency_memberships').update({state:'suspended'}).eq('user_id',owner.user.id)).error)
 assert.equal((await handlers.POST(request({action:'disable',version:3}))).status,403)
 assert.equal((await admin.rpc('disable_outreach_clickup_app',{p_actor:owner.user.id,p_actor_version:actor.data!.version,p_version:3})).error?.code,'42501')
 await grantOutreachOwner(owner.user.id)
 const beforeDisable=await begin()
 assert.equal((await handlers.POST(request({action:'disable',version:3}))).status,200)
 assert.equal((await complete(beforeDisable)).status,500)
 assert.equal((await loadClickUpSettings({...config,clientId:'env-app',clientSecret:'env-secret'})).settings,null)
 assert.equal((await admin.from('outreach_clickup_app').select('secret_id').single()).data?.secret_id,null)
 const remaining=execFileSync('docker',['exec',testDatabaseContainer,'psql','-U','postgres','-d','postgres','-Atc',`select count(*) from vault.secrets where id='${stored.data!.secret_id}'`],{encoding:'utf8'}).trim();assert.equal(remaining,'0')
 assert.equal((await (await clients.GET(cr())).json()).connected,true)
 assert.equal((await clients.POST(cr({action:'disconnect',clientId:tenant.client.id,version:1}))).status,200)
})
