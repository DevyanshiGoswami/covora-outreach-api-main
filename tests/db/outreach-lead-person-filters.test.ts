import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import type { Database } from '../../src/lib/database.types.ts'
import { createOutboundLeadHandlers, type OutboundLeadDirectory } from '../../src/lib/outbound-leads-api.ts'
import { loadTestEnv } from '../helpers/env.ts'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { createAdmin, createTenant } from '../helpers/tenants.ts'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach.ts'

const admin = adminClient()
type Imported = Database['public']['Tables']['outreach_imported_leads']['Insert']
type Query = Database['public']['Functions']['list_outreach_leads_v2']['Args']
const personLocation = (city: string | null, state: string | null, status = 'known') => ({ city, state, country: 'US', status, matchMethod: 'exact_linkedin_and_name', receiptPath: 'private/not-for-client.json' })
async function fixture(t: TestContext, name = 'Hiring Partners · Reviewed', epm = false) {
  const tenant = await createTenant(t, { features: ['outreach_app'], ...(epm ? { client: { id: '26a2cffb-47f4-4231-9195-b4f772751c6d' } } : {}) })
  await grantOutreachMembership(tenant.user.id, tenant.client.id, 'client_viewer')
  const listId = randomUUID()
  assert.ifError((await admin.from('outreach_lead_lists').insert({ id: listId, client_id: tenant.client.id, name, source_sha256: 'a'.repeat(64) })).error)
  const insert = async (rows: Partial<Imported>[]) => {
    const prepared = rows.map((row, i) => ({ id: randomUUID(), client_id: tenant.client.id, list_id: listId, source_row_id: randomUUID().replaceAll('-', '').repeat(2), first_name: `Person ${String(i).padStart(3, '0')}`, last_name: 'Sample', company: 'Medical Manufacturer', review_state: 'client', review_evidence: {}, ...row }))
    assert.ifError((await admin.from('outreach_imported_leads').insert(prepared)).error)
    return prepared.map(row => row.id)
  }
  const list = async (extra: Omit<Query, 'p_client_id'> = {}) => {
    const result = await tenant.supabase.rpc('list_outreach_leads_v2', { p_client_id: tenant.client.id, ...extra })
    assert.ifError(result.error)
    return result.data as unknown as OutboundLeadDirectory
  }
  return { tenant, listId, insert, list }
}

test('audience and exact person filters operate on the full cohort before 36 row pagination', async t => {
  const f = await fixture(t, undefined, true)
  await f.insert(Array.from({ length: 80 }, (_, i) => ({ review_evidence: { personLocation: personLocation(i < 76 ? 'Austin' : 'Boulder', i < 76 ? 'TX' : 'CO') } })))
  await f.insert(Array.from({ length: 2 }, () => ({ review_evidence: { audience: 'athletes', personLocation: personLocation('Seattle', 'WA') } })))
  const otherList = randomUUID()
  assert.ifError((await admin.from('outreach_lead_lists').insert({ id: otherList, client_id: f.tenant.client.id, name: 'Other contacts', source_sha256: 'b'.repeat(64) })).error)
  await f.insert([{ list_id: otherList, location: 'Denver, CO', company: 'Unclassified company' }])
  const all = await f.list()
  assert.equal(all.total, 83)
  assert.equal(all.leads.length, 36)
  assert.equal(all.audienceEnabled, true)
  assert.deepEqual(Object.fromEntries(all.locationOptions.states.map(x => [x.value, x.count])), { 'US|CO': 4, 'US|TX': 76, 'US|WA': 2 })
  const hiring = await f.list({ p_audience: 'hiring_partners' })
  assert.equal(hiring.total, 80)
  assert.equal(hiring.summary.total, 83)
  assert.deepEqual(hiring.locationOptions.states.map(x => x.value), ['US|CO', 'US|TX'])
  const last = await f.list({ p_audience: 'hiring_partners', p_state: 'US|TX', p_city: 'US|TX|Austin', p_page: 1000000 })
  assert.equal(last.total, 76)
  assert.equal(last.page, 3)
  assert.equal(last.leads.length, 4)
  assert.deepEqual(last.locationOptions.cities, [{ value: 'US|TX|Austin', label: 'Austin, TX, US', count: 76 }])
  assert.deepEqual(last.locationOptions.states.map(x => x.value), ['US|CO', 'US|TX'])
  assert.equal((await f.list({ p_audience: 'athletes' })).total, 2)
  assert.equal((await f.list({ p_company: 'Unclassified company', p_state: 'US|CO' })).total, 0)
  assert.equal((await f.list({ p_state: 'US|TX', p_city: 'US|WA|Seattle' })).total, 0)
  assert.deepEqual((await f.list({ p_q: 'no matching record' })).locationOptions, { states: [], cities: [] })
})

test('location facets never infer headquarters, legacy text or conflicting and unmatched profiles', async t => {
  const f = await fixture(t)
  await f.insert([
    { location: 'Austin, Texas', review_evidence: {} },
    { review_evidence: { companyLocation: { city: 'Austin', state: 'TX', country: 'US' } } },
    { review_evidence: { personLocation: personLocation('Austin', 'TX', 'conflict') } },
    { review_evidence: { personLocation: personLocation('Austin', 'TX', 'unknown') } },
    { review_evidence: { personLocation: { ...personLocation('Austin', 'TX'), matchMethod: 'company_headquarters' } } },
    { review_evidence: { personLocation: personLocation(null, 'TX', 'partial') } },
    { review_evidence: { personLocation: personLocation(null, null, 'partial') } },
    { review_evidence: { personLocation: personLocation('Greater Austin Area', null, 'partial') } },
    { review_evidence: { personLocation: { ...personLocation('Toronto', 'ON'), country: 'CA' } } },
    { review_evidence: { personLocation: { ...personLocation(null, null, 'partial'), country: 'not a country' } } },
  ])
  const page = await f.list()
  assert.equal(page.total, 10)
  assert.deepEqual(Object.fromEntries(page.locationOptions.states.map(x => [x.value, x.count])), { 'CA|ON': 1, 'US|TX': 1 })
  assert.deepEqual(page.locationOptions.cities, [{ value: 'CA|ON|Toronto', label: 'Toronto, ON, CA', count: 1 }])
  assert.equal((await f.list({ p_city: 'US|TX|Austin' })).total, 0)
  assert.equal((await f.list({ p_state: 'US|TX' })).total, 1)
  assert.ok(page.leads.filter(x => x.personLocation?.status === 'conflict').every(x => !x.personLocation?.city && !x.personLocation?.state))
  assert.doesNotMatch(JSON.stringify(page), /receiptPath|not-for-client|company_headquarters/)
})

test('research projection preserves caveats and exposes only supported safe observation drafts', async t => {
  const f = await fixture(t)
  const evidence = { audience: 'hiring_partners', researchGaps: 'Confirm hiring responsibility.', icebreakerReview: { status: 'fact_checked', draft: 'Saw the new training program you launched.', sourceUrl: 'https://example.test/news' }, rawProviderResponse: 'private provider record' }
  const [id] = await f.insert([{ fit_reason: 'Company fit needs confirmation.', review_evidence: evidence },
    { review_evidence: { ...evidence, icebreakerReview: { ...evidence.icebreakerReview, status: 'withheld' } } },
    { review_evidence: { ...evidence, icebreakerReview: { ...evidence.icebreakerReview, draft: 'Want to talk?' } } },
    { review_evidence: { ...evidence, icebreakerReview: { ...evidence.icebreakerReview, sourceUrl: 'javascript:alert(1)' } } }])
  const page = await f.list()
  const first = page.leads.find(x => x.id === id)!
  assert.equal(first.fitReason, 'Company fit needs confirmation.')
  assert.equal(first.researchGaps, 'Confirm hiring responsibility.')
  assert.equal(first.icebreaker, evidence.icebreakerReview.draft)
  assert.equal(page.leads.filter(x => x.icebreaker).length, 1)
  assert.doesNotMatch(JSON.stringify(page), /private provider record|rawProviderResponse|javascript/)
})

test('v2 retains tenant and role checks, escrow identity fencing and unchanged v1 contract', async t => {
  const f = await fixture(t, 'Legacy contacts'), foreign = await fixture(t)
  const unassigned = await createAdmin(t), owner = await createAdmin(t)
  await grantOutreachOwner(owner.user.id)
  await f.insert([{ email: 'visible@example.test', location: 'Austin, TX' }, { email: 'held@example.test', review_state: 'escrow', review_reason: 'Excluded company', reviewed_at: new Date().toISOString(), review_evidence: { audience: 'athletes', personLocation: personLocation('Hidden city', 'ZZ') } }])
  const c = await admin.from('outreach_campaigns').insert({ client_id: f.tenant.client.id, name: 'Campaign mirror', provider_campaign_id: randomUUID() }).select('id').single()
  assert.ifError(c.error)
  assert.ifError((await admin.from('outreach_leads').insert({ client_id: f.tenant.client.id, campaign_id: c.data!.id, email: 'held@example.test' })).error)
  const page = await f.list()
  assert.equal(page.total, 1)
  assert.equal(page.audienceEnabled, false)
  assert.deepEqual(page.locationOptions, { states: [], cities: [] })
  assert.doesNotMatch(JSON.stringify(page), /held@example|Hidden city/)
  const v1 = await f.tenant.supabase.rpc('list_outreach_leads', { p_client_id: f.tenant.client.id })
  assert.ifError(v1.error)
  assert.equal((v1.data as unknown as OutboundLeadDirectory).total, 1)
  assert.equal('audienceEnabled' in (v1.data as object), false)
  for (const session of [foreign.tenant.supabase, unassigned.supabase, anonClient()]) {
    assert.equal((await session.rpc('list_outreach_leads_v2', { p_client_id: f.tenant.client.id })).error?.code, '42501')
  }
  assert.ifError((await owner.supabase.rpc('list_outreach_leads_v2', { p_client_id: f.tenant.client.id })).error)
  for (const role of ['client_admin', 'client_member', 'client_viewer'] as const) {
    assert.ifError((await admin.from('outreach_memberships').update({ role }).eq('user_id', f.tenant.user.id)).error)
    assert.equal((await f.list()).total, 1)
  }
  assert.ifError((await admin.from('outreach_memberships').update({ state: 'revoked' }).eq('user_id', f.tenant.user.id)).error)
  assert.equal((await f.tenant.supabase.rpc('list_outreach_leads_v2', { p_client_id: f.tenant.client.id })).error?.code, '42501')
  assert.ifError((await admin.from('client_features').update({ enabled: false }).eq('client_id', f.tenant.client.id)).error)
  assert.equal((await owner.supabase.rpc('list_outreach_leads_v2', { p_client_id: f.tenant.client.id })).error?.code, '42501')
})

test('v2 validates new filter enums and bounds independently of the API', async t => {
  const f = await fixture(t)
  for (const query of [{ p_audience: 'customers' }, { p_state: 'x'.repeat(251) }, { p_city: 'x'.repeat(251) }, { p_state: 'US\nTX' }]) {
    assert.equal((await f.tenant.supabase.rpc('list_outreach_leads_v2', { p_client_id: f.tenant.client.id, ...query })).error?.code, '22023')
  }
})

test('fresh exact email recovery overrides historical unknown validation without approving outreach', async t => {
  const f = await fixture(t)
  const recovery = { email: 'recovered@example.test', provider: 'zerobounce', providerStatus: 'valid', providerVerifiedAt: '2026-10-22T17:00:00Z', catchall: false, freeEmail: false, identityMatched: true, currentEmployerMatched: true, employerDomainSupported: true, mailboxReceiptSha256: 'a'.repeat(64), identityReceiptSha256: 'b'.repeat(64), sourceReviewSha256: 'c'.repeat(64), sendAllowed: false }
  const [id] = await f.insert([{ email: recovery.email, email_verification: 'verified', email_verification_evidence: 'Current strict mailbox receipt', linkedin_url: 'https://www.linkedin.com/in/synthetic-recovered', review_evidence: { emailValidation: 'unknown', contactPreference: 'linkedin_first', emailRecovery: recovery, outreachAuthorized: false } },
    { email: 'different@example.test', email_verification: 'verified', email_verification_evidence: 'Other validation', review_evidence: { emailValidation: 'risky', emailRecovery: recovery } },
    { email: 'catchall@example.test', email_verification: 'verified', email_verification_evidence: 'Other validation', review_evidence: { emailValidation: 'unknown', emailRecovery: { ...recovery, email: 'catchall@example.test', catchall: true } } },
    { email: 'no-provenance@example.test', email_verification: 'verified', email_verification_evidence: 'Other validation', review_evidence: { emailValidation: 'unknown', emailRecovery: { ...recovery, email: 'no-provenance@example.test', mailboxReceiptSha256: null } } }])
  const page = await f.list()
  const row = page.leads.find(x => x.id === id)!
  assert.equal(row.emailValidation, 'valid')
  assert.equal(row.contactPreference, 'email_and_linkedin')
  assert.equal(page.leads.filter(x => x.emailValidation === 'valid').length, 1)
  assert.doesNotMatch(JSON.stringify(page), /emailRecovery|mailboxReceiptSha256|sendAllowed/)
  const stored = await admin.from('outreach_imported_leads').select('review_evidence').eq('id', id).single()
  assert.ifError(stored.error)
  assert.equal((stored.data!.review_evidence as Record<string, unknown>).emailValidation, 'unknown')
  const campaign = await admin.from('outreach_campaigns').insert({ client_id: f.tenant.client.id, name: 'Bounce mirror', provider_campaign_id: randomUUID() }).select('id').single()
  assert.ifError(campaign.error)
  assert.ifError((await admin.from('outreach_leads').insert({ client_id: f.tenant.client.id, campaign_id: campaign.data!.id, email: recovery.email, status: 'bounced' })).error)
  const bounced = (await f.list()).leads.find(x => x.id === id)!
  assert.equal(bounced.emailVerification, 'unverified')
  assert.equal(bounced.emailValidation, 'invalid')
})


test('real authenticated API adapter returns person filtered data and neutral denied responses', async t => {
  const f = await fixture(t, undefined, true), foreign = await fixture(t)
  await f.insert([{ review_evidence: { personLocation: personLocation('Austin', 'TX') }, fit_reason: 'Hiring responsibility needs review.' }])
  const env = loadTestEnv(), api = createOutboundLeadHandlers({ url: env.URL, anonKey: env.ANON, fetch })
  const session = await f.tenant.supabase.auth.getSession(), other = await foreign.tenant.supabase.auth.getSession()
  const url = `https://local-api.invalid/api/outbound/leads?clientId=${f.tenant.client.id}&audience=hiring_partners&state=US%7CTX`
  const response = await api.GET(new Request(url, { headers: { authorization: `Bearer ${session.data.session!.access_token}` } }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.total, 1)
  assert.equal(body.audienceEnabled, true)
  assert.equal(body.leads[0].personLocation.city, 'Austin')
  assert.equal(body.leads[0].fitReason, 'Hiring responsibility needs review.')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await api.GET(new Request(url))).status, 401)
  assert.equal((await api.GET(new Request(url, { headers: { authorization: `Bearer ${other.data.session!.access_token}` } }))).status, 403)
})
