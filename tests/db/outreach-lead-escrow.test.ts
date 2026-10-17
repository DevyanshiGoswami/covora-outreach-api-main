import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { createTenant, createAdmin, type CleanupScope } from '../helpers/tenants.ts'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach.ts'
import { prepareLegacyLeadImport } from '../../src/lib/outreach-lead-import.ts'
import type { OutboundLeadDirectory } from '../../src/lib/outbound-leads-api.ts'
import type { OutboundEscrowDirectory } from '../../src/lib/outbound-escrow-leads-api.ts'

const admin = adminClient()
const reviewed = '2026-10-17T18:00:00Z'
async function fixture(t: CleanupScope, escrowSize = 40) {
  const tenant = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(tenant.user.id, tenant.client.id, 'client_viewer')
  const visibleList = randomUUID(), hiddenList = randomUUID()
  assert.ifError((await admin.from('outreach_lead_lists').insert([
    { id: visibleList, client_id: tenant.client.id, name: 'Priority roster', source_sha256: 'a'.repeat(64) },
    { id: hiddenList, client_id: tenant.client.id, name: 'Private research queue', source_sha256: 'b'.repeat(64) },
  ])).error)
  const source = (i: number) => ({ firstName: `Person ${String(i).padStart(5,'0')}`, lastName: 'Sample', company: `Visible ${i}`, title: 'Marketing Director', location: 'United States', email: `contact-${i}@example.test`, linkedinUrl: `https://www.linkedin.com/in/review-${i}` })
  const { rows: published } = prepareLegacyLeadImport([source(1), source(2)], { clientId: tenant.client.id, listId: visibleList })
  assert.ifError((await admin.from('outreach_imported_leads').insert(published.map((row,i) => ({ ...row, priority_rank: 2-i, fit_reason: 'Marketing purchasing remit.', reviewed_at: reviewed,
    email_verification: i ? 'unknown' : 'verified', email_verification_evidence: i ? null : 'Validation check passed on 2026-10-17.',
    review_evidence: { emailValidation: i ? 'risky' : 'valid', contactPreference: i ? 'linkedin_first' : 'email_and_linkedin', researchGaps: 'Budget is unknown.', sourceUrls: ['https://example.com/company','javascript:bad','http://localhost/private','https://user:secret@example.com/','https://127.0.0.1/private'], private_provider_key: 'never-publish-me' },
  })))).error)
  const { rows: held } = prepareLegacyLeadImport(Array.from({ length: escrowSize }, (_,i) => ({ ...source(100+i), company: `Hidden company ${i}` })), { clientId: tenant.client.id, listId: hiddenList })
  assert.ifError((await admin.from('outreach_imported_leads').insert(held.map(row => ({ ...row, review_state: 'escrow', review_reason: 'Needs further investigation.', reviewed_at: reviewed })))).error)
  return { tenant, visibleList, hiddenList, published, held }
}

test('escrow is absent from client counts, search, filters and pages, including agency client previews', async t => {
  const f = await fixture(t), owner = await createAdmin(t)
  await grantOutreachOwner(owner.user.id)
  for (const session of [f.tenant.supabase, owner.supabase]) {
    const listed = await session.rpc('list_outreach_leads', { p_client_id: f.tenant.client.id })
    assert.ifError(listed.error)
    const page = listed.data as unknown as OutboundLeadDirectory
    assert.equal(page.total,2)
    assert.equal(page.summary.total,2)
    assert.equal(page.summary.verifiedEmail,1)
    assert.deepEqual(page.companies,['Visible 1','Visible 2'])
    assert.deepEqual(page.lists,[{ id:f.visibleList,name:'Priority roster' }])
    assert.deepEqual(page.leads.map(row => row.priorityRank),[1,2])
    assert.deepEqual(page.leads[0].sourceUrls,['https://example.com/company'])
    assert.equal(page.leads[0].emailValidation,'risky')
    assert.equal(page.leads[0].emailVerification,'unknown')
    assert.equal(page.leads[0].contactPreference,'linkedin_first')
    assert.doesNotMatch(JSON.stringify(page),/Hidden|Private research|never-publish|private_provider|review_state|localhost/)
    for (const filters of [{p_q:'Hidden'}, {p_list:f.hiddenList}, {p_company:'Hidden company 0'}]) {
      const r = await session.rpc('list_outreach_leads', { p_client_id:f.tenant.client.id,...filters })
      assert.ifError(r.error)
      assert.equal((r.data as unknown as OutboundLeadDirectory).total,0)
      assert.ok(!(r.data as unknown as OutboundLeadDirectory).lists.some(row => row.id===f.hiddenList))
    }
    const byName = await session.rpc('list_outreach_leads', { p_client_id:f.tenant.client.id,p_sort:'name',p_page:1000000 })
    assert.deepEqual((byName.data as unknown as OutboundLeadDirectory).leads.map(row => row.priorityRank),[2,1])
    assert.equal((byName.data as unknown as OutboundLeadDirectory).page,1)
  }
})

test('only active agency owners and explicitly assigned operators can read escrow; feature and tenant denial remain authoritative', async t => {
  const f = await fixture(t), other = await fixture(t), owner = await createAdmin(t), operator = await createAdmin(t), stranger = await createAdmin(t)
  await grantOutreachOwner(owner.user.id)
  await grantOutreachMembership(operator.user.id,f.tenant.client.id,'operator')
  for (const role of ['client_viewer','client_member','client_admin'] as const) {
    await grantOutreachMembership(f.tenant.user.id,f.tenant.client.id,role)
    assert.equal((await f.tenant.supabase.rpc('list_outreach_escrow_leads',{p_client_id:f.tenant.client.id})).error?.code,'42501')
  }
  for (const session of [anonClient(),stranger.supabase,other.tenant.supabase]) {
    assert.ok((await session.rpc('list_outreach_escrow_leads',{p_client_id:f.tenant.client.id})).error)
  }
  for (const session of [owner.supabase,operator.supabase]) {
    const result = await session.rpc('list_outreach_escrow_leads',{p_client_id:f.tenant.client.id})
    assert.ifError(result.error)
    const page = result.data as unknown as OutboundEscrowDirectory
    assert.equal(page.total,40); assert.equal(page.leads.length,36)
    assert.deepEqual(page.summary,{escrow:40,clientVisible:2})
    assert.ok(page.leads.every(row=>row.reviewState==='escrow'&&row.priorityRank===null&&row.clientId===f.tenant.client.id))
    assert.ok((await session.from('outreach_imported_leads').select('*')).error)
    assert.ok((await session.from('outreach_imported_leads').update({review_state:'client'}).eq('client_id',f.tenant.client.id)).error)
    const last = await session.rpc('list_outreach_escrow_leads',{p_client_id:f.tenant.client.id,p_page:1000000})
    assert.equal((last.data as unknown as OutboundEscrowDirectory).page,2)
    assert.equal((last.data as unknown as OutboundEscrowDirectory).leads.length,4)
    const search = await session.rpc('list_outreach_escrow_leads',{p_client_id:f.tenant.client.id,p_q:'Hidden company 39'})
    assert.equal((search.data as unknown as OutboundEscrowDirectory).total,1)
    assert.equal((search.data as unknown as OutboundEscrowDirectory).summary.escrow,40)
  }
  assert.equal((await operator.supabase.rpc('list_outreach_escrow_leads',{p_client_id:other.tenant.client.id})).error?.code,'42501')
  assert.ifError((await admin.from('outreach_memberships').update({state:'suspended'}).eq('user_id',operator.user.id)).error)
  assert.equal((await operator.supabase.rpc('list_outreach_escrow_leads',{p_client_id:f.tenant.client.id})).error?.code,'42501')
  assert.ifError((await admin.from('client_features').update({enabled:false}).eq('client_id',f.tenant.client.id)).error)
  assert.equal((await owner.supabase.rpc('list_outreach_escrow_leads',{p_client_id:f.tenant.client.id})).error?.code,'42501')
})

test('review constraints preserve original rows and reject ambiguous rank or escrow state', async t => {
  const f = await fixture(t,1), owner = await createAdmin(t)
  await grantOutreachOwner(owner.user.id)
  const held = f.held[0]
  for (const extra of [{review_state:'other'}, {priority_rank:1}, {review_reason:null}, {reviewed_at:null}, {review_evidence:[] }]) {
    assert.ok((await admin.from('outreach_imported_leads').update(extra).eq('id',held.id)).error)
  }
  assert.equal((await admin.from('outreach_imported_leads').update({priority_rank:1}).eq('id',f.published[0].id)).error?.code,'23505')
  for (const extra of [{p_page:0},{p_page:1000001},{p_q:'x'.repeat(201)}]) {
    assert.equal((await owner.supabase.rpc('list_outreach_escrow_leads',{p_client_id:f.tenant.client.id,...extra})).error?.code,'22023')
  }
  const records = await admin.from('outreach_imported_leads').select('id,source_row_id,email,linkedin_url').eq('client_id',f.tenant.client.id)
  assert.ifError(records.error)
  assert.equal(records.data!.length,3)
  for (const source of [...f.published,...f.held]) {
    assert.deepEqual(records.data!.find(row=>row.id===source.id), {id:source.id,source_row_id:source.source_row_id,email:source.email,linkedin_url:source.linkedin_url})
  }
})
