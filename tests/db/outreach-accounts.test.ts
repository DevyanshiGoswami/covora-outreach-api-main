import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { createTenant, createAdmin } from '../helpers/tenants.ts'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach.ts'
const admin = adminClient()

async function fixture(t: Parameters<typeof createTenant>[0]) {
  const a = await createTenant(t, { features: ['outreach_app'] })
  const b = await createTenant(t, { features: ['outreach_app'] })
  const owner = await createAdmin(t)
  const operator = await createAdmin(t)
  await grantOutreachOwner(owner.user.id)
  await grantOutreachMembership(operator.user.id,a.client.id,'operator')
  await grantOutreachMembership(a.user.id,a.client.id,'client_admin')
  await grantOutreachMembership(b.user.id,b.client.id,'client_viewer')
  const config={p_client_id:a.client.id,p_remote_workspace_id:randomUUID(),p_credential_ref:'OUTREACH_INSTANTLY_TEST_'+randomUUID().replaceAll('-','').toUpperCase(),p_enabled:true}
  assert.ifError((await owner.supabase.rpc('configure_outreach_account_workspace',config)).error)
  return {a,b,owner,operator,config}
}

test('account registry configuration and registration enforce active explicit agency roles',async(t)=>{
  const {a,b,owner,operator,config}=await fixture(t)
  for(const session of [a.supabase,b.supabase,operator.supabase,anonClient()]) assert.ok((await session.rpc('configure_outreach_account_workspace',config)).error)
  const input={p_client_id:a.client.id,p_email:`Sender+pilot-${randomUUID()}@Example.test`,p_display_name:'Pilot sender'}
  for(const session of [a.supabase,b.supabase,anonClient()]) assert.ok((await session.rpc('register_outreach_account',input)).error)
  assert.ok((await operator.supabase.rpc('register_outreach_account',{...input,p_client_id:b.client.id})).error)
  const registered=await operator.supabase.rpc('register_outreach_account',input)
  assert.ifError(registered.error)
  const repeat=await owner.supabase.rpc('register_outreach_account',{...input,p_email:' '+input.p_email.toLowerCase()+' '})
  assert.ifError(repeat.error); assert.equal(repeat.data,registered.data)
  const read=await a.supabase.from('client_outreach_accounts').select('*')
  assert.ifError(read.error); assert.equal(read.data?.length,1)
  assert.equal(read.data?.[0].email,input.p_email.toLowerCase()); assert.equal(read.data?.[0].state,'unverified')
  assert.equal(read.data?.[0].last_checked_at,null)
  assert.ok(!JSON.stringify(read.data).includes(config.p_remote_workspace_id))
  assert.deepEqual((await b.supabase.from('client_outreach_accounts').select('*')).data,[])
  for(const table of ['outreach_accounts','outreach_account_workspaces','outreach_account_checks'] as const) assert.ok((await a.supabase.from(table).select('*')).error)
  // @ts-expect-error Deliberately bypass the generated read-only view type to prove the database also denies writes.
  assert.ok((await a.supabase.from('client_outreach_accounts').update({state:'connected'}).eq('id',registered.data!)).error)
})

async function register(f: Awaited<ReturnType<typeof fixture>>, email=`pilot-${randomUUID()}@example.test`) {
  const row=await f.operator.supabase.rpc('register_outreach_account',{p_client_id:f.a.client.id,p_email:email,p_display_name:'Pilot'})
  assert.ifError(row.error); return row.data!
}
async function start(f: Awaited<ReturnType<typeof fixture>>,id:string) {
  const row=await f.operator.supabase.rpc('begin_outreach_account_check',{p_client_id:f.a.client.id,p_account_id:id})
  assert.ifError(row.error); return row.data!
}
async function clearCooldown(clientId:string,id:string) {
  assert.ifError((await admin.from('outreach_accounts').update({last_attempt_at:'2000-01-01T00:00:00Z'}).eq('id',id)).error)
  assert.ifError((await admin.from('outreach_account_workspaces').update({last_check_started_at:null}).eq('client_id',clientId)).error)
}

test('only a current fenced agency check can persist health, and failed checks preserve observations',async(t)=>{
  const f=await fixture(t); const id=await register(f)
  const check=await start(f,id)
  for(const session of [f.a.supabase,f.b.supabase,f.operator.supabase,anonClient()]) {
    assert.ok((await session.rpc('read_outreach_account_check',{p_check_id:check})).error)
    assert.ok((await session.rpc('finish_outreach_account_check',{p_check_id:check,p_state:'connected'})).error)
  }
  const context=await admin.rpc('read_outreach_account_check',{p_check_id:check})
  assert.ifError(context.error); assert.equal(context.data?.[0].remote_workspace_id,f.config.p_remote_workspace_id)
  assert.ok((await f.operator.supabase.rpc('begin_outreach_account_check',{p_client_id:f.a.client.id,p_account_id:id})).error)
  const finish=await admin.rpc('finish_outreach_account_check',{p_check_id:check,p_state:'connected'})
  assert.ifError(finish.error); assert.equal(finish.data,true)
  assert.equal((await admin.rpc('finish_outreach_account_check',{p_check_id:check,p_state:'needs_attention'})).data,false)
  const before=(await f.a.supabase.from('client_outreach_accounts').select('*').eq('id',id).single()).data!
  assert.equal(before.state,'connected'); assert.ok(before.last_checked_at); assert.ok(before.last_connected_at)
  await clearCooldown(f.a.client.id,id)
  const failCheck=await start(f,id)
  assert.equal((await admin.rpc('finish_outreach_account_check',{p_check_id:failCheck,p_error_code:'check_unavailable'})).data,true)
  const after=(await f.a.supabase.from('client_outreach_accounts').select('*').eq('id',id).single()).data!
  assert.equal(after.check_error,true); assert.equal(after.state,'connected'); assert.equal(after.last_checked_at,before.last_checked_at); assert.equal(after.last_connected_at,before.last_connected_at)
})

test('revocation, changed configuration, expiry and superseded checks cannot report connected',async(t)=>{
  const f=await fixture(t); const id=await register(f); const check=await start(f,id)
  assert.ifError((await admin.from('outreach_memberships').update({state:'revoked'}).eq('client_id',f.a.client.id).eq('user_id',f.operator.user.id)).error)
  assert.equal((await admin.rpc('finish_outreach_account_check',{p_check_id:check,p_state:'connected'})).data,false)
  await grantOutreachMembership(f.operator.user.id,f.a.client.id,'operator')
  assert.equal((await admin.rpc('finish_outreach_account_check',{p_check_id:check,p_state:'connected'})).data,false,'reactivation changes authority version')
  assert.ifError((await f.owner.supabase.rpc('configure_outreach_account_workspace',{...f.config,p_remote_workspace_id:randomUUID()})).error)
  assert.equal((await admin.rpc('finish_outreach_account_check',{p_check_id:check,p_state:'connected'})).data,false)
  const currentAuthorityCheck=await start(f,id)
  assert.ifError((await f.owner.supabase.rpc('configure_outreach_account_workspace',{...f.config,p_remote_workspace_id:randomUUID()})).error)
  assert.equal((await admin.rpc('finish_outreach_account_check',{p_check_id:currentAuthorityCheck,p_state:'connected'})).data,false,'configuration alone fences a check with current actor authority')
  const second=await start(f,id)
  assert.ifError((await admin.from('outreach_account_checks').update({expires_at:'2000-01-01T00:00:00Z'}).eq('id',second)).error)
  const expired=(await f.a.supabase.from('client_outreach_accounts').select('*').eq('id',id).single()).data!
  assert.equal(expired.check_error,true); assert.equal(expired.last_checked_at,null)
  await clearCooldown(f.a.client.id,id); const third=await start(f,id)
  assert.equal((await admin.rpc('finish_outreach_account_check',{p_check_id:second,p_state:'connected'})).data,false)
  assert.equal((await admin.rpc('finish_outreach_account_check',{p_check_id:third,p_state:'paused'})).data,true)
  assert.equal((await f.a.supabase.from('client_outreach_accounts').select('state').eq('id',id).single()).data?.state,'paused')
})

test('global normalized email reservations isolate competing independent clients',async(t)=>{
  const f=await fixture(t)
  assert.ifError((await f.owner.supabase.rpc('configure_outreach_account_workspace',{...f.config,p_client_id:f.b.client.id,p_remote_workspace_id:randomUUID(),p_credential_ref:f.config.p_credential_ref+'_B'})).error)
  const address=`same-${randomUUID()}@example.test`
  const raced=await Promise.all([f.a.client.id,f.b.client.id].map(p_client_id=>f.owner.supabase.rpc('register_outreach_account',{p_client_id,p_email:address,p_display_name:''})))
  assert.equal(raced.filter(r=>!r.error).length,1); assert.equal(raced.filter(r=>r.error?.code==='22023').length,1)

})

test('disabled product and client admins cannot begin checks or mutate immutable audit',async(t)=>{
  const f=await fixture(t); const id=await register(f)
  for(const [session,clientId] of [[f.a.supabase,f.a.client.id],[f.b.supabase,f.a.client.id],[f.operator.supabase,f.b.client.id]] as const) assert.ok((await session.rpc('begin_outreach_account_check',{p_client_id:clientId,p_account_id:id})).error)
  const check=await start(f,id)
  assert.ifError((await admin.from('client_features').update({enabled:false}).eq('client_id',f.a.client.id).eq('feature','outreach_app')).error)
  assert.equal((await admin.rpc('finish_outreach_account_check',{p_check_id:check,p_state:'connected'})).data,false)
  assert.deepEqual((await f.owner.supabase.from('client_outreach_accounts').select('*').eq('client_id',f.a.client.id)).data,[])
  assert.ok((await f.owner.supabase.rpc('register_outreach_account',{p_client_id:f.a.client.id,p_email:'new@example.test',p_display_name:''})).error)
  const audit=await admin.from('outreach_access_audit').select('id').eq('subject_id',id)
  assert.ifError(audit.error); assert.ok(audit.data!.length>=2)
  assert.ok((await admin.from('outreach_access_audit').delete().eq('id',audit.data![0].id)).error)
})
