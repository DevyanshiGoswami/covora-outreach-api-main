import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import type { Database } from '../../src/lib/database.types.ts'
import { createOutboundLeadHandlers, type OutboundLeadDirectory } from '../../src/lib/outbound-leads-api.ts'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { loadTestEnv } from '../helpers/env.ts'
import { createAdmin, createTenant } from '../helpers/tenants.ts'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach.ts'

const admin = adminClient()
const EPM = '26a2cffb-47f4-4231-9195-b4f772751c6d'
type Imported = Database['public']['Tables']['outreach_imported_leads']['Insert']
type Query = Database['public']['Functions']['list_outreach_leads_v2']['Args']
const location = (city: string, state: string) => ({ city, state, country: 'US', status: 'known', matchMethod: 'exact_linkedin_and_name' })
async function fixture(t: TestContext, epm = true) {
  const tenant = await createTenant(t, { features: ['outreach_app'], ...(epm ? { client: { id: EPM } } : {}) })
  await grantOutreachMembership(tenant.user.id, tenant.client.id, 'client_viewer')
  const listId = randomUUID()
  assert.ifError((await admin.from('outreach_lead_lists').insert({ id: listId, client_id: tenant.client.id, name: 'Athletes · Reviewed', source_sha256: 'a'.repeat(64) })).error)
  const insert = async (rows: Partial<Imported>[]) => {
    const prepared = rows.map((row, i) => ({
      id: randomUUID(), client_id: tenant.client.id, list_id: listId, source_row_id: randomUUID().replaceAll('-', '').repeat(2),
      first_name: `Person ${String(i).padStart(3, '0')}`, last_name: 'Sample', company: 'Synthetic Medical Company', review_state: 'client',
      email: `person-${randomUUID()}@example.test`, email_verification: 'verified', email_verification_evidence: 'Synthetic exact mailbox check',
      linkedin_url: `https://www.linkedin.com/in/${randomUUID()}`, linkedin_verified: true, linkedin_verification_evidence: 'Synthetic exact profile check',
      review_evidence: { audience: 'athletes', emailValidation: 'valid' }, ...row,
    }))
    assert.ifError((await admin.from('outreach_imported_leads').insert(prepared)).error)
    return prepared
  }
  const list = async (extra: Omit<Query, 'p_client_id'> = {}) => {
    const result = await tenant.supabase.rpc('list_outreach_leads_v2', { p_client_id: tenant.client.id, ...extra })
    assert.ifError(result.error)
    return result.data as unknown as OutboundLeadDirectory
  }
  return { tenant, listId, insert, list }
}

const source = { url: 'https://example.com/profile', title: 'Public profile', fact: 'Explicit dated profile statement', checkedAt: '2026-10-22T12:00:00Z' }
const review = (tags = ['currently_in_sales', 'former_athlete']) => ({ status: tags.length ? 'reviewed' : 'needs_review', tags, rationale: 'Current sales role and completed athletics', qualificationGaps: ['Confirm current availability and eligibility'], researchedAt: '2026-10-27T12:00:00Z', sources: [source],
  tagEvidence: tags.map(tag => ({ tag, rationale: `Explicit support for ${tag}`, sources: [source] })), outreachApprovalGranted: false, qualificationEstablished: false })
test('athlete segments require exact reviewed tags with their own dated public support and never infer transition', async t => {
 const f = await fixture(t)
 const evidence = review()
 const cases = [
  { meta: evidence, expected: ['currently_in_sales', 'former_athlete'] },
  { meta: review(['current_student_athlete']), expected: ['current_student_athlete'] },
  { meta: review(['career_transition']), expected: ['career_transition'] },
  { meta: review([]), expected: [] },
  { meta: { ...evidence, status: 'draft' }, expected: [] },
  { meta: { ...evidence, status: 'needs_review' }, expected: [] },
  { meta: { ...evidence, tags: ['career_transition'] }, expected: [] },
  { meta: { ...evidence, tagEvidence: [] }, expected: [] },
  { meta: { ...evidence, tagEvidence: evidence.tagEvidence.map(entry => ({ ...entry, sources: [] })) }, expected: [] },
  { meta: { ...evidence, tagEvidence: evidence.tagEvidence.map(entry => ({ ...entry, sources: [{ ...source, checkedAt: '2026-02-31T12:00:00Z' }] })) }, expected: [] },
  { meta: { ...evidence, tagEvidence: evidence.tagEvidence.map(entry => ({ ...entry, sources: [{ ...source, url: 'https://office.internal/' }] })) }, expected: [] },
  { meta: { ...evidence, tags: ['former_athlete', 'former_athlete'], tagEvidence: [evidence.tagEvidence[1], evidence.tagEvidence[1]] }, expected: ['former_athlete'] },
 ]
 const rows = await f.insert(cases.map(({ meta }, i) => ({ priority_rank: i + 1, fit_reason: 'Existing fit assessment', reviewed_at: '2026-10-22T12:00:00Z', job_title: 'Student athlete former sales seeking career transition',
   review_evidence: { audience: 'athletes', athleteSegmentReview: meta, careerTransition: true, fitScore: 100, researchGaps: 'Existing hold stays unchanged' } })))
 const page = await f.list()
 assert.equal(page.athleteSegmentsEnabled, true)
 cases.forEach((value, i) => {
  const lead = page.leads.find(lead => lead.id === rows[i].id)!
  assert.deepEqual(lead.athleteSegments!.tags, value.expected)
  assert.equal(lead.priorityRank, i + 1); assert.equal(lead.researchGaps, 'Existing hold stays unchanged')
 })
 const first = page.leads.find(lead => lead.id === rows[0].id)!
 assert.equal(first.athleteSegments!.reviewedAt, '2026-10-27T12:00:00Z')
 assert.equal(first.athleteSegments!.tagEvidence[0].sources[0].checkedAt, source.checkedAt)
 assert.doesNotMatch(JSON.stringify(page), /outreachApprovalGranted|qualificationEstablished|fitScore|careerTransition/)
 const missing = await f.insert([{ review_evidence: { audience: 'athletes', profileEvidence: { currentRoleTitle: 'Sales executive' } } }])
 const unknown = await f.list({ p_athlete_status: 'unassigned' })
 assert.equal(unknown.total, cases.filter(value => !value.expected.length).length + 1)
 assert.ok(unknown.leads.some(lead => lead.id === missing[0].id))
 assert.ok(unknown.leads.every(lead => lead.athleteSegments!.tags.length === 0))
 const saved = await admin.from('outreach_imported_leads').select('review_evidence').eq('id', rows[0].id).single()
 assert.deepEqual(saved.data!.review_evidence, rows[0].review_evidence)
})

test('athlete filter combines overlap, search, location and pagination without losing company tiers or unrelated contacts', async t => {
 const f = await fixture(t)
 await f.insert(Array.from({ length: 42 }, (_, i) => ({ company: 'Example Company', first_name: `Sales ${String(i).padStart(3, '0')}`, review_evidence: { audience: 'athletes', athleteSegmentReview: review(), personLocation: location('Austin', 'TX') } })))
 await f.insert([{ review_evidence: { audience: 'athletes', athleteSegmentReview: review(['current_student_athlete']), personLocation: location('Miami', 'FL') } },
  { review_evidence: { audience: 'hiring_partners', companyFit: { assessedTier: 2 }, athleteSegmentReview: review() } }])
 const sales = await f.list({ p_athlete_status: 'currently_in_sales', p_page: 999, p_state: 'US|TX', p_city: 'US|TX|Austin', p_q: 'Sales' })
 assert.equal(sales.total, 42); assert.equal(sales.page, 2); assert.equal(sales.leads.length, 6); assert.equal(sales.summary.total, 44)
 assert.deepEqual(sales.locationOptions.states, [{ value: 'US|TX', label: 'TX, US', count: 42 }])
 assert.ok(sales.leads.every(lead => lead.athleteSegments!.tags.includes('former_athlete')))
 assert.equal((await f.list({ p_athlete_status: 'former_athlete' })).total, 42)
 assert.equal((await f.list({ p_athlete_status: 'career_transition' })).total, 0)
 assert.equal((await f.list({ p_athlete_status: 'currently_in_sales', p_tier: '2' })).total, 0)
 const hiring = await f.list({ p_tier: '2' }); assert.equal(hiring.total, 1); assert.equal('athleteSegments' in hiring.leads[0], false)
})

test('athlete segment queries preserve every role, tenant denial, escrow and campaign eligibility fencing', async t => {
 const f = await fixture(t), foreign = await fixture(t, false), outsider = await createAdmin(t), owner = await createAdmin(t)
 await grantOutreachOwner(owner.user.id)
 const rows = await f.insert([
  { review_evidence: { audience: 'athletes', athleteSegmentReview: review() } },
  { review_evidence: { audience: 'athletes', athleteSegmentReview: review(), epmFitRanking: { classification: 'eligibility_review_hold' } } },
  { review_state: 'escrow', review_reason: 'Needs more review', reviewed_at: new Date().toISOString(), review_evidence: { audience: 'athletes', athleteSegmentReview: review() } },
 ])
 await foreign.insert([{ review_evidence: { audience: 'athletes', athleteSegmentReview: review() } }])
 assert.equal((await foreign.list()).athleteSegmentsEnabled, false)
 assert.equal('athleteSegments' in (await foreign.list()).leads[0], false)
 assert.equal((await foreign.list({ p_athlete_status: 'currently_in_sales' })).total, 0)
 const planId = randomUUID()
 assert.ifError((await admin.from('outreach_campaign_plans').insert({ id: planId, client_id: EPM, slug: 'athlete_linkedin', name: 'Athlete LinkedIn', audience: 'athletes', channel: 'linkedin' })).error)
 assert.ifError((await admin.from('outreach_campaign_plan_memberships').insert(rows.map(row => ({ plan_id: planId, client_id: EPM, lead_id: row.id })))).error)
 const plan = await f.list({ p_plan: planId, p_athlete_status: 'currently_in_sales' })
 assert.equal(plan.total, 1); assert.equal(plan.selectedPlan!.leadCount, 1); assert.equal(plan.leads[0].id, rows[0].id)
 assert.equal((await f.list({ p_plan: planId, p_athlete_status: 'career_transition' })).summary.total, 1)
 for (const session of [foreign.tenant.supabase, outsider.supabase, anonClient()]) assert.equal((await session.rpc('list_outreach_leads_v2', { p_client_id: EPM, p_athlete_status: 'currently_in_sales' })).error?.code, '42501')
 assert.ifError((await owner.supabase.rpc('list_outreach_leads_v2', { p_client_id: EPM, p_athlete_status: 'currently_in_sales' })).error)
 for (const role of ['client_admin', 'client_member', 'client_viewer', 'operator'] as const) {
  assert.ifError((await admin.from('outreach_memberships').update({ role }).eq('user_id', f.tenant.user.id)).error)
  assert.equal((await f.list({ p_athlete_status: 'currently_in_sales' })).total, 2)
 }
 for (const value of ['', 'current_sales_role', 'unknown', 'all\n', null]) assert.equal((await f.tenant.supabase.rpc('list_outreach_leads_v2', { p_client_id: EPM, p_athlete_status: value as string })).error?.code, '22023')
 assert.ifError((await admin.from('outreach_memberships').update({ state: 'revoked' }).eq('user_id', f.tenant.user.id)).error)
 assert.equal((await f.tenant.supabase.rpc('list_outreach_leads_v2', { p_client_id: EPM, p_athlete_status: 'currently_in_sales' })).error?.code, '42501')
})

test('athlete API independently validates the persisted segment projection and retains read-only no-store behavior', async t => {
 const f = await fixture(t), foreign = await fixture(t, false)
 await f.insert([{ review_evidence: { audience: 'athletes', athleteSegmentReview: review() } }])
 const env = loadTestEnv(), api = createOutboundLeadHandlers({ url: env.URL, anonKey: env.ANON, fetch })
 const token = (await f.tenant.supabase.auth.getSession()).data.session!.access_token
 const foreignToken = (await foreign.tenant.supabase.auth.getSession()).data.session!.access_token
 const url = `https://api.invalid/api/outbound/leads?clientId=${EPM}&audience=athletes&athleteStatus=currently_in_sales`
 const response = await api.GET(new Request(url, { headers: { authorization: `Bearer ${token}` } }))
 assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
 const page = await response.json() as OutboundLeadDirectory
 assert.equal(page.total, 1); assert.deepEqual(page.leads[0].athleteSegments!.tags, ['currently_in_sales', 'former_athlete'])
 assert.equal((await api.GET(new Request(url))).status, 401)
 assert.equal((await api.GET(new Request(url, { headers: { authorization: `Bearer ${foreignToken}` } }))).status, 403)
})
