import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import type { Database, Json } from '../../src/lib/database.types.ts'
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
  assert.ifError((await admin.from('outreach_lead_lists').insert({ id: listId, client_id: tenant.client.id, name: 'Hiring Partners · Reviewed', source_sha256: 'a'.repeat(64) })).error)
  const insert = async (rows: Partial<Imported>[]) => {
    const prepared = rows.map((row, i) => ({
      id: randomUUID(), client_id: tenant.client.id, list_id: listId, source_row_id: randomUUID().replaceAll('-', '').repeat(2),
      first_name: `Person ${String(i).padStart(3, '0')}`, last_name: 'Sample', company: 'Synthetic Medical Company', review_state: 'client',
      email: `person-${randomUUID()}@example.test`, email_verification: 'verified', email_verification_evidence: 'Synthetic exact mailbox check',
      linkedin_url: `https://www.linkedin.com/in/${randomUUID()}`, linkedin_verified: true, linkedin_verification_evidence: 'Synthetic exact profile check',
      review_evidence: { audience: 'hiring_partners', emailValidation: 'valid' }, ...row,
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

test('EPM tiers use exact reviewed evidence, preserve caveats, and leave malformed or inferred tiers unassigned', async t => {
  const f = await fixture(t)
  const cases: { evidence: Json; expected: number | null }[] = [
    ...[1, 2, 3, '1', '2', '3'].map(tier => ({ evidence: { companyFit: { assessedTier: tier } }, expected: Number(tier) })),
    ...[null, 0, 4, 1.5, true, '01', '1.0', ' 1', 'Tier 2', [], { tier: 1 }].map(tier => ({ evidence: { companyFit: { assessedTier: tier } }, expected: null })),
    { evidence: { companyFit: { assessedTier: 2 }, hiringTierReview: { tier: 3, status: 'reviewed' } }, expected: 3 },
    { evidence: { companyFit: { assessedTier: 2 }, hiringTierReview: { tier: '1', status: 'reviewed' } }, expected: 1 },
    { evidence: { companyFit: { assessedTier: 2 }, hiringTierReview: { tier: 3, status: 'draft' } }, expected: 2 },
    { evidence: { companyFit: { assessedTier: 2 }, hiringTierReview: { tier: 'Tier 1', status: 'reviewed' } }, expected: 2 },
    { evidence: { hiringTierReview: { tier: 3, status: 'draft' }, tier: 1, score: 100, selectionTier: 2, epmFitRanking: { tier: 1, score: 100 } }, expected: null },
    { evidence: {}, expected: null },
  ]
  const rows = await f.insert(cases.map(({ evidence }, i) => ({
    reviewed_at: new Date().toISOString(), priority_rank: i + 1, job_title: 'Tier 1 Distributor President', fit_reason: 'Eligibility and hiring authority still need confirmation.',
    review_evidence: { ...(evidence as Record<string, Json>), audience: 'hiring_partners', researchGaps: 'FDA and internal TA evidence remain unresolved.', outreachAuthorized: false },
  })))
  const page = await f.list()
  assert.equal(page.tierEnabled, true)
  assert.equal(page.total, cases.length)
  rows.forEach((row, i) => {
    const shown = page.leads.find(lead => lead.id === row.id)!
    assert.equal(shown.hiringTier, cases[i].expected, JSON.stringify(cases[i].evidence))
    assert.equal(shown.priorityRank, i + 1)
    assert.equal(shown.fitReason, 'Eligibility and hiring authority still need confirmation.')
    assert.equal(shown.researchGaps, 'FDA and internal TA evidence remain unresolved.')
  })
  const unassigned = await f.list({ p_tier: 'unassigned' })
  assert.equal(unassigned.total, cases.filter(row => row.expected === null).length)
  assert.ok(unassigned.leads.every(row => row.hiringTier === null && row.audience === 'hiring_partners'))
  assert.doesNotMatch(JSON.stringify(page), /companyFit|hiringTierReview|outreachAuthorized|epmFitRanking/)
  const saved = await admin.from('outreach_imported_leads').select('review_evidence').eq('id', rows[17].id).single()
  assert.ifError(saved.error)
  assert.deepEqual(saved.data!.review_evidence, rows[17].review_evidence)
})

test('tier projection and filtering remain restricted to EPM hiring partners, excluding athletes and other clients', async t => {
  const f = await fixture(t), foreign = await fixture(t, false)
  const [hiring, athlete, unknown] = await f.insert([
    { review_evidence: { audience: 'hiring_partners', companyFit: { assessedTier: 2 } } },
    { review_evidence: { audience: 'athletes', companyFit: { assessedTier: 2 } } },
    { review_evidence: { audience: 'hiring_partners' } },
  ])
  await foreign.insert([{ review_evidence: { audience: 'hiring_partners', companyFit: { assessedTier: 2 } } }])
  const all = await f.list()
  assert.equal(all.total, 3)
  assert.equal(all.leads.find(row => row.id === hiring.id)!.hiringTier, 2)
  assert.equal('hiringTier' in all.leads.find(row => row.id === athlete.id)!, false)
  assert.equal(all.leads.find(row => row.id === unknown.id)!.hiringTier, null)
  assert.deepEqual((await f.list({ p_tier: '2' })).leads.map(row => row.id), [hiring.id])
  assert.deepEqual((await f.list({ p_tier: 'unassigned' })).leads.map(row => row.id), [unknown.id])
  assert.equal((await f.list({ p_audience: 'athletes', p_tier: '2' })).total, 0)
  assert.equal((await f.list({ p_audience: 'athletes', p_tier: 'unassigned' })).total, 0)
  const other = await foreign.list()
  assert.equal(other.tierEnabled, false)
  assert.equal('hiringTier' in other.leads[0], false)
  assert.equal((await foreign.list({ p_tier: '2' })).total, 0)
  assert.equal((await foreign.list({ p_tier: 'unassigned' })).total, 0)
})

test('tier filters precede pagination and combine with person location without changing full directory summaries', async t => {
  const f = await fixture(t)
  await f.insert(Array.from({ length: 80 }, (_, i) => ({
    first_name: `Tier two ${String(i).padStart(3, '0')}`,
    review_evidence: { companyFit: { assessedTier: 2 }, personLocation: location(i < 76 ? 'Austin' : 'Boulder', i < 76 ? 'TX' : 'CO') },
  })))
  await f.insert([{ review_evidence: { companyFit: { assessedTier: 1 }, personLocation: location('Miami', 'FL') } },
    { review_evidence: { audience: 'athletes', personLocation: location('Seattle', 'WA') } }])
  const first = await f.list({ p_tier: '2' })
  assert.equal(first.total, 80)
  assert.equal(first.summary.total, 82)
  assert.equal(first.leads.length, 36)
  assert.ok(first.leads.every(row => row.hiringTier === 2))
  assert.deepEqual(first.locationOptions.states.map(option => option.value), ['US|CO', 'US|TX'])
  const last = await f.list({ p_tier: '2', p_state: 'US|TX', p_city: 'US|TX|Austin', p_page: 1000000 })
  assert.equal(last.total, 76)
  assert.equal(last.page, 3)
  assert.equal(last.leads.length, 4)
  assert.equal(new Set(last.leads.map(row => row.id)).size, 4)
  assert.deepEqual(last.locationOptions.cities, [{ value: 'US|TX|Austin', label: 'Austin, TX, US', count: 76 }])
  assert.equal((await f.list({ p_tier: '1', p_state: 'US|TX' })).total, 0)
  assert.deepEqual((await f.list({ p_tier: '3' })).locationOptions, { states: [], cities: [] })
})

test('tier filtering preserves campaign plan eligibility and roster totals and supports existing callers without an overload ambiguity', async t => {
  const f = await fixture(t)
  const planId = randomUUID()
  assert.ifError((await admin.from('outreach_campaign_plans').insert({ id: planId, client_id: EPM, slug: 'hiring_email', name: 'Hiring email', audience: 'hiring_partners', channel: 'email' })).error)
  const rows = await f.insert([
    { review_evidence: { companyFit: { assessedTier: 2 }, emailValidation: 'valid' } },
    { review_evidence: { companyFit: { assessedTier: 3 }, emailValidation: 'valid' } },
    { review_evidence: { companyFit: { assessedTier: 2 }, emailValidation: 'valid', epmFitRanking: { classification: 'eligibility_review_hold' } } },
    { review_evidence: { companyFit: { assessedTier: 2 }, emailValidation: 'risky' } },
    { review_evidence: { companyFit: { assessedTier: 2 }, emailValidation: 'valid' } },
  ])
  assert.ifError((await admin.from('outreach_campaign_plan_memberships').insert(rows.slice(0, 4).map(row => ({ plan_id: planId, client_id: EPM, lead_id: row.id })))).error)
  const oldCall = await f.list({ p_plan: planId })
  assert.equal(oldCall.total, 2)
  assert.equal(oldCall.selectedPlan!.leadCount, 2)
  assert.deepEqual((await f.list({ p_plan: planId, p_tier: 'all' })).leads, oldCall.leads)
  const filtered = await f.list({ p_plan: planId, p_tier: '2' })
  assert.equal(filtered.total, 1)
  assert.equal(filtered.summary.total, 2)
  assert.equal(filtered.selectedPlan!.leadCount, 2)
  assert.deepEqual(filtered.leads.map(row => row.id), [rows[0].id])
  assert.equal((await f.list({ p_plan: planId, p_tier: 'unassigned' })).total, 0)
  const v1 = await f.tenant.supabase.rpc('list_outreach_leads', { p_client_id: EPM })
  assert.ifError(v1.error)
  assert.equal('tierEnabled' in (v1.data as object), false)
  assert.ok((v1.data as unknown as OutboundLeadDirectory).leads.every(row => !('hiringTier' in row)))
})

test('tier reads retain tenant and role authorization, escrow fencing and independent database filter validation', async t => {
  const f = await fixture(t), foreign = await fixture(t, false), outsider = await createAdmin(t), owner = await createAdmin(t)
  await grantOutreachOwner(owner.user.id)
  await f.insert([{ review_evidence: { companyFit: { assessedTier: 1 } } },
    { email: 'held@example.test', review_state: 'escrow', review_reason: 'Needs identity review', reviewed_at: new Date().toISOString(), review_evidence: { companyFit: { assessedTier: 1 } } }])
  const campaign = await admin.from('outreach_campaigns').insert({ client_id: EPM, name: 'Synthetic escrow mirror', provider_campaign_id: randomUUID() }).select('id').single()
  assert.ifError(campaign.error)
  assert.ifError((await admin.from('outreach_leads').insert({ client_id: EPM, campaign_id: campaign.data!.id, email: 'held@example.test' })).error)
  assert.equal((await f.list({ p_tier: '1' })).total, 1)
  for (const session of [foreign.tenant.supabase, outsider.supabase, anonClient()]) {
    assert.equal((await session.rpc('list_outreach_leads_v2', { p_client_id: EPM, p_tier: '1' })).error?.code, '42501')
  }
  assert.ifError((await owner.supabase.rpc('list_outreach_leads_v2', { p_client_id: EPM, p_tier: '1' })).error)
  for (const role of ['client_admin', 'client_member', 'client_viewer', 'operator'] as const) {
    assert.ifError((await admin.from('outreach_memberships').update({ role }).eq('user_id', f.tenant.user.id)).error)
    assert.equal((await f.list({ p_tier: '1' })).total, 1)
  }
  for (const tier of ['', '0', '4', 'Tier 1', '01', '1.0', ' 1', 'all\n', null]) {
    assert.equal((await f.tenant.supabase.rpc('list_outreach_leads_v2', { p_client_id: EPM, p_tier: tier as string })).error?.code, '22023')
  }
  assert.ifError((await admin.from('outreach_memberships').update({ state: 'revoked' }).eq('user_id', f.tenant.user.id)).error)
  assert.equal((await f.tenant.supabase.rpc('list_outreach_leads_v2', { p_client_id: EPM, p_tier: '1' })).error?.code, '42501')
  assert.ifError((await admin.from('client_features').update({ enabled: false }).eq('client_id', EPM)).error)
  assert.equal((await owner.supabase.rpc('list_outreach_leads_v2', { p_client_id: EPM, p_tier: '1' })).error?.code, '42501')
})

test('authenticated tier API returns filtered evidence with no-store responses and rejects foreign readers', async t => {
  const f = await fixture(t), foreign = await fixture(t, false)
  await f.insert([{ review_evidence: { companyFit: { assessedTier: 2 } } }, { review_evidence: { companyFit: { assessedTier: 3 } } }])
  const env = loadTestEnv(), api = createOutboundLeadHandlers({ url: env.URL, anonKey: env.ANON, fetch })
  const token = (await f.tenant.supabase.auth.getSession()).data.session!.access_token
  const foreignToken = (await foreign.tenant.supabase.auth.getSession()).data.session!.access_token
  const url = `https://api.invalid/api/outbound/leads?clientId=${EPM}&audience=hiring_partners&tier=2`
  const response = await api.GET(new Request(url, { headers: { authorization: `Bearer ${token}` } }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const page = await response.json() as OutboundLeadDirectory
  assert.equal(page.total, 1)
  assert.equal(page.tierEnabled, true)
  assert.equal(page.leads[0].hiringTier, 2)
  assert.equal((await api.GET(new Request(url))).status, 401)
  assert.equal((await api.GET(new Request(url, { headers: { authorization: `Bearer ${foreignToken}` } }))).status, 403)
})

test('tier review projects only bounded public evidence for reviewed and unresolved EPM companies', async t => {
  const f = await fixture(t), foreign = await fixture(t, false)
  const review = { status: 'reviewed', tier: 1, rationale: 'Independent\n distributor', qualificationGaps: ['Confirm\t hiring', null, { secret: 'hidden' }],
    sources: [{ url: 'https://example.com/company', title: 'Company profile', fact: 'Represents manufacturers', checkedAt: '2026-10-27T00:00:00Z', privateKey: 'hidden' },
      { url: 'https://example.com/company?token=private#fragment', title: 'Unsafe', fact: 'Not a source' }, { url: 'javascript:alert(1)', title: 'Unsafe', fact: 'Not a source' }, { url: 'https://user:pass@example.com/', title: 'Unsafe', fact: 'Not a source' },
      { url: 'https://office.internal/', title: 'Private', fact: 'Not public' }], researchedAt: '2026-10-27T00:00:00Z', companyKey: 'private', qualificationEstablished: false }
  const rows = await f.insert([
    { review_evidence: { audience: 'hiring_partners', hiringTierReview: review } },
    { review_evidence: { audience: 'hiring_partners', hiringTierReview: { ...review, tier: null, status: 'needs_review' } } },
    { review_evidence: { audience: 'athletes', hiringTierReview: review } },
    { review_evidence: { audience: 'hiring_partners', hiringTierReview: { ...review, status: 'draft' } } },
    { review_evidence: { audience: 'hiring_partners', hiringTierReview: { status: 'needs_review', rationale: 'x'.repeat(3000), qualificationGaps: Array(20).fill('x'.repeat(700)), sources: Array(20).fill({ url: 'https://example.com/', title: 'x'.repeat(400), fact: 'x'.repeat(1000) }) } } },
    { review_evidence: { audience: 'hiring_partners', hiringTierReview: { status: 'needs_review', rationale: {}, qualificationGaps: {}, sources: {} } } },
  ])
  await foreign.insert([{ review_evidence: { audience: 'hiring_partners', hiringTierReview: review } }])
  const page = await f.list(), shown = rows.map(row => page.leads.find(lead => lead.id === row.id)!)
  const expected = { rationale: 'Independent distributor', gaps: ['Confirm hiring'], sources: [{ url: 'https://example.com/company', title: 'Company profile', fact: 'Represents manufacturers' }] }
  assert.deepEqual(shown[0].hiringTierEvidence, expected)
  assert.deepEqual(shown[1].hiringTierEvidence, expected)
  assert.equal(shown[1].hiringTier, null)
  assert.equal('hiringTierEvidence' in shown[2], false)
  assert.equal('hiringTierEvidence' in shown[3], false)
  assert.equal('hiringTierEvidence' in (await foreign.list()).leads[0], false)
  assert.equal(shown[4].hiringTierEvidence!.rationale.length, 2000)
  assert.equal(shown[4].hiringTierEvidence!.gaps.length, 12)
  assert.equal(shown[4].hiringTierEvidence!.gaps[0].length, 500)
  assert.equal(shown[4].hiringTierEvidence!.sources.length, 10)
  assert.equal(shown[4].hiringTierEvidence!.sources[0].fact.length, 800)
  assert.deepEqual(shown[5].hiringTierEvidence, { rationale: '', gaps: [], sources: [] })
  assert.doesNotMatch(JSON.stringify(page), /privateKey|companyKey|qualificationEstablished|checkedAt|token=|fragment|javascript|office.internal/)
})
