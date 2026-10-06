import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { createTenant, createAdmin } from '../helpers/tenants.ts'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach.ts'
import { prepareLegacyLeadImport } from '../../src/lib/outreach-lead-import.ts'
import type { OutboundLeadDirectory } from '../../src/lib/outbound-leads-api.ts'
import type { Database } from '../../src/lib/database.types.ts'

const admin = adminClient()
async function fixture(t: TestContext, size = 2) {
  const tenant = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(tenant.user.id, tenant.client.id, 'client_viewer')
  const listId = randomUUID()
  assert.ifError((await admin.from('outreach_lead_lists').insert({ id: listId, client_id: tenant.client.id, name: 'Imported\u001f prospects', source_sha256: 'a'.repeat(64) })).error)
  const { rows } = prepareLegacyLeadImport(Array.from({ length: size }, (_, i) => ({ firstName: `Person ${String(i).padStart(5,'0')}`, lastName: 'Sample', company: `Company ${i % 20}`, title: 'CEO', location: 'Boston', email: `fixture-${i}@example.test`, linkedinUrl: `https://www.linkedin.com/in/sample-${i}`, verified: true, verifiedReason: 'Prior source role check' })), { clientId: tenant.client.id, listId })
  for (let i=0;i<rows.length;i+=1000) assert.ifError((await admin.from('outreach_imported_leads').insert(rows.slice(i,i+1000))).error)
  async function list(extra: Partial<Database['public']['Functions']['list_outreach_leads']['Args']> = {}) {
    const result = await tenant.supabase.rpc('list_outreach_leads', { p_client_id: tenant.client.id, ...extra })
    assert.ifError(result.error)
    return result.data as unknown as OutboundLeadDirectory
  }
  return { tenant, listId, rows, list }
}

test('imported lists preserve tenant authorization and deny all raw client access', async t => {
  const a = await fixture(t), b = await fixture(t)
  const unassigned = await createAdmin(t), owner = await createAdmin(t)
  await grantOutreachOwner(owner.user.id)
  for (const session of [a.tenant.supabase,b.tenant.supabase,unassigned.supabase,anonClient()]) {
    for (const table of ['outreach_lead_lists','outreach_imported_leads'] as const) {
      assert.ok((await session.from(table).select('*')).error)
      assert.ok((await session.from(table).delete().eq('client_id',a.tenant.client.id)).error)
    }
  }
  for (const session of [b.tenant.supabase,unassigned.supabase,anonClient()]) assert.equal((await session.rpc('list_outreach_leads',{p_client_id:a.tenant.client.id})).error?.code,'42501')
  assert.ifError((await owner.supabase.rpc('list_outreach_leads',{p_client_id:a.tenant.client.id})).error)
  const denied = await admin.from('outreach_imported_leads').insert({ ...a.rows[0], id: randomUUID(), client_id: b.tenant.client.id, source_row_id: 'b'.repeat(64), email: 'other@example.test' })
  assert.equal(denied.error?.code,'23503')
  assert.ifError((await admin.from('outreach_memberships').update({state:'suspended'}).eq('user_id',a.tenant.user.id)).error)
  assert.equal((await a.tenant.supabase.rpc('list_outreach_leads',{p_client_id:a.tenant.client.id})).error?.code,'42501')
  assert.ifError((await admin.from('client_features').update({enabled:false}).eq('client_id',a.tenant.client.id)).error)
  assert.equal((await owner.supabase.rpc('list_outreach_leads',{p_client_id:a.tenant.client.id})).error?.code,'42501')
})

test('imported lists union with campaign leads without affecting campaign analytics or existing projections', async t => {
  const f = await fixture(t)
  const campaign = await admin.from('outreach_campaigns').insert({client_id:f.tenant.client.id,name:'Live campaign',provider_campaign_id:randomUUID()}).select('id').single()
  assert.ifError(campaign.error)
  assert.ifError((await admin.from('outreach_leads').insert({client_id:f.tenant.client.id,campaign_id:campaign.data!.id,email:'live@example.test',first_name:'Live',company:'Other'})).error)
  const page = await f.list()
  assert.equal(page.total,3)
  assert.deepEqual(page.lists,[{id:f.listId,name:'Imported prospects'}])
  assert.equal(page.campaigns.length,1)
  const imported = await f.list({p_list:f.listId,p_linkedin:'verified',p_status:'not_contacted',p_q:'Boston'})
  assert.equal(imported.total,2)
  assert.equal(imported.summary.verifiedEmail,0)
  assert.ok(imported.leads.every(r=>r.campaignId===null && r.campaignName===null && r.listId===f.listId))
  assert.equal((await f.list({p_email:'verified'})).total,0)
  assert.equal((await f.list({p_campaign:campaign.data!.id})).total,1)
  assert.equal((await f.list({p_campaign:campaign.data!.id,p_list:f.listId})).total,0)
  assert.equal((await f.list({p_list:randomUUID()})).total,0)
  assert.equal((await f.list({p_q:'Imported prospects'})).total,2)
  assert.doesNotMatch(JSON.stringify(page),/source_row|source_sha|Prior source|provider_/)
  assert.equal((await f.tenant.supabase.from('client_outreach_leads').select('*')).data?.length,1)
  assert.equal((await f.tenant.supabase.from('client_outreach_campaigns').select('*')).data?.length,1)
})

test('10k imported rows retain global totals, search and stable server pagination', async t => {
  const f = await fixture(t,10025)
  const page = await f.list()
  assert.equal(page.total,10025)
  assert.equal(page.leads.length,36)
  assert.equal(page.summary.withLinkedIn,10025)
  assert.equal((await f.list({p_q:'Person 10024'})).total,1)
  const last = await f.list({p_page:1000000,p_sort:'name'})
  assert.equal(last.page,279)
  assert.equal(last.leads.length,17)
  assert.equal(last.leads.at(-1)?.firstName,'Person 10024')
  assert.equal((await f.list({p_company:'Company 19'})).total,501)
})

test('import evidence and idempotency constraints reject invented verification and duplicate rows', async t => {
  const f = await fixture(t)
  assert.equal((await admin.from('outreach_imported_leads').insert(f.rows[0])).error?.code,'23505')
  for (const extra of [{ email_verification:'verified',email_verification_evidence:null },{linkedin_verified:true,linkedin_verification_evidence:null},{status:'replied'}]) {
    assert.equal((await admin.from('outreach_imported_leads').insert({...f.rows[0],id:randomUUID(),source_row_id:'c'.repeat(64),email:'unique@example.test',...extra})).error?.code,'23514')
  }
})

test('workspace preview mode defaults live and never grants membership or feature access', async t => {
  const f = await fixture(t), outsider = await createAdmin(t)
  const mode = async () => (await f.tenant.supabase.from('client_outreach_workspaces').select('presentation_mode').single()).data?.presentation_mode
  assert.equal(await mode(),'live')
  assert.ifError((await admin.from('client_features').update({config:{presentation_mode:'preview'}}).eq('client_id',f.tenant.client.id).eq('feature','outreach_app')).error)
  assert.equal(await mode(),'preview')
  assert.deepEqual((await outsider.supabase.from('client_outreach_workspaces').select('*')).data,[])
  assert.ifError((await admin.from('client_features').update({enabled:false}).eq('client_id',f.tenant.client.id)).error)
  assert.deepEqual((await f.tenant.supabase.from('client_outreach_workspaces').select('*')).data,[])
})

test('bounded list facets retain only an authorized selected list beyond the cap', async t => {
  const f = await fixture(t), foreign = await fixture(t)
  const lists = Array.from({length:502},(_,i)=>({ id:randomUUID(),client_id:f.tenant.client.id,name:`Roster ${String(i).padStart(4,'0')}`,source_sha256:'a'.repeat(64) }))
  assert.ifError((await admin.from('outreach_lead_lists').insert(lists)).error)
  const page=await f.list()
  assert.equal(page.lists.length,500)
  assert.equal(page.filterOptionsTruncated,true)
  const selected=await f.list({p_list:lists[501].id})
  assert.equal(selected.lists.length,501)
  assert.ok(selected.lists.some(list=>list.id===lists[501].id))
  const foreignSelected=await f.list({p_list:foreign.listId})
  assert.equal(foreignSelected.total,0)
  assert.ok(foreignSelected.lists.every(list=>list.id!==foreign.listId))
})
