import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { adminClient, anonClient } from '../helpers/admin'
import { createAdmin, createTenant } from '../helpers/tenants'
import { grantOutreachMembership, grantOutreachOwner, grantAgencyControls } from '../helpers/outreach'
import { peopleSchema } from '../../src/lib/onboarding-contract'
const db=adminClient()
async function people(session:ReturnType<typeof anonClient>,client:string) {
 const result=await session.rpc('list_outreach_people',{p_client:client});assert.ifError(result.error)
 return peopleSchema.parse(result.data)
}
async function team(session:ReturnType<typeof anonClient>,client:string) {
 const result=await session.from('client_outreach_team').select('*').eq('client_id',client);assert.ifError(result.error)
 return result.data
}
async function enableEmail(client:string) {
 assert.ifError((await db.from('outreach_account_workspaces').insert({client_id:client,credential_ref:`OUTREACH_INSTANTLY_${randomUUID().replaceAll('-','').toUpperCase()}`,remote_workspace_id:randomUUID(),enabled:true})).error)
}

test('existing owners join only Covora; ownership is a derived grant and repeats do not duplicate people',async t=>{
 const owner=await createAdmin(t);await grantOutreachOwner(owner.user.id)
 const covora=await createTenant(t,{slug:'covora',features:['outreach_app']}),other=await createTenant(t,{features:['outreach_app']})
 let rows=await people(owner.supabase,covora.client.id)
 assert.equal(rows.length,1);assert.equal(rows[0].email,owner.user.email);assert.equal(rows[0].agencyOwner,true);assert.equal(rows[0].canConnect,true)
 const id=rows[0].id
 for(let i=0;i<2;i++)await grantOutreachOwner(owner.user.id)
 rows=await people(owner.supabase,covora.client.id);assert.equal(rows.length,1);assert.equal(rows[0].id,id)
 const members=await team(owner.supabase,covora.client.id);assert.equal(members.length,1);assert.equal(members[0].is_agency_owner,true)
 assert.equal((await team(owner.supabase,other.client.id)).length,0);assert.equal((await people(owner.supabase,other.client.id)).length,0)
 const explicit=await db.from('outreach_memberships').select('*').eq('user_id',owner.user.id);assert.ifError(explicit.error);assert.deepEqual(explicit.data,[])
 assert.equal((await db.from('outreach_connections').select('*').eq('person_id',id)).data?.length,0)
 assert.equal((await anonClient().from('client_outreach_team').select('*')).error?.code,'42501')
 assert.equal((await team(other.supabase,covora.client.id)).length,0)
})

test('accepting an owner invitation links the same verified person and preserves an existing connection',async t=>{
 const covora=await createTenant(t,{slug:'covora',features:['outreach_app']}),owner=await createAdmin(t),invitee=await createAdmin(t)
 await grantOutreachOwner(owner.user.id);await enableEmail(covora.client.id)
 const manual=await owner.supabase.rpc('create_outreach_person',{p_client_id:covora.client.id,p_name:'Existing sender',p_email:invitee.user.email});assert.ifError(manual.error)
 const started=await owner.supabase.rpc('prepare_outreach_connection',{p_person:manual.data!,p_channel:'email',p_action:'start'});assert.ifError(started.error)
 assert.equal((await db.rpc('finish_outreach_connection',{p_id:started.data![0].connection_id,p_lease:started.data![0].claim_token!,p_state:'connected',p_remote_account:invitee.user.email})).data,true)
 const invitation=await owner.supabase.rpc('create_outreach_owner_invitation',{p_email:invitee.user.email});assert.ifError(invitation.error)
 assert.equal((await people(owner.supabase,covora.client.id)).find(p=>p.id===manual.data)?.source,'external')
 for(let i=0;i<2;i++)assert.ifError((await invitee.supabase.rpc('accept_outreach_owner_invitation',{p_token:invitation.data![0].token})).error)
 const matches=(await people(invitee.supabase,covora.client.id)).filter(p=>p.email===invitee.user.email)
 assert.equal(matches.length,1);assert.equal(matches[0].id,manual.data);assert.equal(matches[0].name,'Existing sender')
 assert.equal(matches[0].source,'team');assert.equal(matches[0].agencyOwner,true);assert.equal(matches[0].connections[0].state,'connected')
 assert.equal(matches[0].canConnect,true)
 assert.equal((await people(owner.supabase,covora.client.id)).find(p=>p.id===manual.data)?.canConnect,false)
 assert.equal((await owner.supabase.rpc('prepare_outreach_connection',{p_person:manual.data!,p_channel:'email',p_action:'start'})).error?.code,'42501')
})

test('owner removal drops automatic team access, fences a pending connection and preserves independent membership',async t=>{
 const covora=await createTenant(t,{slug:'covora',features:['outreach_app']}),manager=await createAdmin(t),owner=await createAdmin(t),independent=await createAdmin(t)
 await grantOutreachOwner(manager.user.id);await grantAgencyControls(manager.user.id)
 await grantOutreachMembership(independent.user.id,covora.client.id,'client_member')
 const before=await db.from('outreach_memberships').select('*').eq('user_id',independent.user.id).single();assert.ifError(before.error)
 await grantOutreachOwner(owner.user.id);await grantOutreachOwner(independent.user.id);await enableEmail(covora.client.id)
 const own=(await people(owner.supabase,covora.client.id)).find(p=>p.isSelf)!
 const claim=await owner.supabase.rpc('prepare_outreach_connection',{p_person:own.id,p_channel:'email',p_action:'start'});assert.ifError(claim.error)
 const pending=claim.data![0]
 assert.ifError((await manager.supabase.rpc('revoke_outreach_owner',{p_user_id:owner.user.id,p_expected_version:1})).error)
 assert.equal((await team(manager.supabase,covora.client.id)).some(m=>m.user_id===owner.user.id),false)
 assert.equal((await owner.supabase.rpc('list_outreach_people',{p_client:covora.client.id})).error?.code,'42501')
 assert.equal((await db.rpc('finish_outreach_connection',{p_id:pending.connection_id,p_lease:pending.claim_token!,p_state:'connected',p_remote_account:owner.user.email})).data,false)
 const former=(await people(manager.supabase,covora.client.id)).find(p=>p.id===own.id)!
 assert.equal(former.access,'revoked');assert.equal(former.agencyOwner,false);assert.equal(former.connections[0].state,'needs_review')
 assert.ifError((await manager.supabase.rpc('revoke_outreach_owner',{p_user_id:independent.user.id,p_expected_version:1})).error)
 const after=await db.from('outreach_memberships').select('*').eq('user_id',independent.user.id).single();assert.ifError(after.error);assert.deepEqual(after.data,before.data)
 const row=(await team(manager.supabase,covora.client.id)).find(m=>m.user_id===independent.user.id)!
 assert.equal(row.is_agency_owner,false);assert.equal(row.state,'active');assert.equal(row.role,'client_member')
 assert.equal((await people(independent.supabase,covora.client.id)).find(p=>p.isSelf)?.canConnect,true)
})

test('owner access overrides an independent viewer only in Covora and suspension restores viewer restrictions',async t=>{
 const covora=await createTenant(t,{slug:'covora',features:['outreach_app']}),other=await createTenant(t,{features:['outreach_app']}),owner=await createAdmin(t)
 for(const tenant of [covora,other])await grantOutreachMembership(owner.user.id,tenant.client.id,'client_viewer')
 await grantOutreachOwner(owner.user.id)
 assert.equal((await people(owner.supabase,covora.client.id)).find(p=>p.isSelf)?.canConnect,true)
 assert.equal((await people(owner.supabase,other.client.id)).find(p=>p.isSelf)?.canConnect,false)
 assert.equal((await people(owner.supabase,other.client.id)).find(p=>p.isSelf)?.agencyOwner,false)
 assert.ifError((await db.from('outreach_agency_memberships').update({state:'suspended'}).eq('user_id',owner.user.id)).error)
 assert.equal((await people(owner.supabase,covora.client.id)).find(p=>p.isSelf)?.canConnect,false)
 assert.equal((await people(owner.supabase,covora.client.id)).find(p=>p.isSelf)?.access,'active')
})
