import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import type { Database, Json } from '../../src/lib/database.types.ts'
import { createOutboundCampaignPlanHandlers, type OutboundCampaignPlan } from '../../src/lib/outbound-campaign-plans-api.ts'
import { createOutboundLeadHandlers, type OutboundLeadDirectory } from '../../src/lib/outbound-leads-api.ts'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { loadTestEnv } from '../helpers/env.ts'
import { createAdmin, createTenant } from '../helpers/tenants.ts'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach.ts'

const admin = adminClient()
type Lead = Database['public']['Tables']['outreach_imported_leads']['Insert']
async function fixture(t: TestContext) {
  const tenant = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(tenant.user.id, tenant.client.id, 'client_viewer')
  const listId = randomUUID()
  assert.ifError((await admin.from('outreach_lead_lists').insert({ id: listId, client_id: tenant.client.id, name: 'Hiring Partners', source_sha256: 'a'.repeat(64) })).error)
  const plans = [
    { id: randomUUID(), client_id: tenant.client.id, slug: 'manufacturer_linkedin', name: 'Manufacturer LinkedIn', audience: 'hiring_partners', channel: 'linkedin' },
    { id: randomUUID(), client_id: tenant.client.id, slug: 'manufacturer_email', name: 'Manufacturer Email', audience: 'hiring_partners', channel: 'email' },
    { id: randomUUID(), client_id: tenant.client.id, slug: 'athlete_linkedin', name: 'Athlete LinkedIn', audience: 'athletes', channel: 'linkedin' },
  ]
  assert.ifError((await admin.from('outreach_campaign_plans').insert(plans)).error)
  const insert = async (rows: Partial<Lead>[], planIds = [plans[0].id, plans[1].id]) => {
    const prepared = rows.map((row, i) => ({ id: randomUUID(), client_id: tenant.client.id, list_id: listId, source_row_id: randomUUID().replaceAll('-', '').repeat(2), first_name: `Person ${i}`, last_name: 'Sample', company: 'Medical Example', review_state: 'client', email: `person-${randomUUID()}@example.test`, email_verification: 'verified', email_verification_evidence: 'Synthetic exact mailbox check', linkedin_url: `https://www.linkedin.com/in/${randomUUID()}`, linkedin_verified: true, linkedin_verification_evidence: 'Synthetic exact profile check', review_evidence: { audience: 'hiring_partners', emailValidation: 'valid' }, ...row }))
    assert.ifError((await admin.from('outreach_imported_leads').insert(prepared)).error)
    assert.ifError((await admin.from('outreach_campaign_plan_memberships').insert(prepared.flatMap(row => planIds.map(plan_id => ({ plan_id, client_id: tenant.client.id, lead_id: row.id }))))).error)
    return prepared
  }
  const list = async () => {
    const result = await tenant.supabase.rpc('list_outreach_campaign_plans', { p_client_id: tenant.client.id })
    assert.ifError(result.error)
    return (result.data as unknown as { campaigns: OutboundCampaignPlan[] }).campaigns
  }
  const directory = async (planId: string, extra: Partial<Database['public']['Functions']['list_outreach_leads_v2']['Args']> = {}) => {
    const result = await tenant.supabase.rpc('list_outreach_leads_v2', { p_client_id: tenant.client.id, p_plan: planId, ...extra })
    assert.ifError(result.error)
    return result.data as unknown as OutboundLeadDirectory
  }
  return { tenant, listId, plans, insert, list, directory }
}

test('native plans reuse canonical people without provider records, preserve filters and never create sync work', async t => {
  const f = await fixture(t)
  const [row] = await f.insert([{ priority_rank: 1, fit_reason: 'Supported fit with authority still under review.', reviewed_at: new Date().toISOString(), review_evidence: { audience: 'hiring_partners', emailValidation: 'valid', personLocation: { city: 'Austin', state: 'TX', country: 'US', status: 'known', matchMethod: 'exact_linkedin_and_name' }, icebreakerReview: { status: 'fact_checked', draft: 'Saw the new training program.', sourceUrl: 'https://example.test/news' } } }])
  const all = await f.tenant.supabase.rpc('list_outreach_leads_v2', { p_client_id: f.tenant.client.id })
  assert.ifError(all.error)
  assert.equal((all.data as unknown as OutboundLeadDirectory).total, 1)
  for (const plan of f.plans.slice(0, 2)) {
    const page = await f.directory(plan.id, { p_state: 'US|TX', p_city: 'US|TX|Austin' })
    assert.equal(page.total, 1)
    assert.equal(page.selectedPlan!.leadCount, 1)
    assert.equal(page.leads[0].id, row.id)
    assert.equal(page.leads[0].priorityRank, 1)
    assert.equal(page.leads[0].personLocation?.city, 'Austin')
    assert.equal(page.leads[0].icebreaker, 'Saw the new training program.')
    assert.equal(page.leads[0].status, 'not_contacted')
    assert.equal(page.leads[0].campaignId, null)
  }
  assert.equal((await f.directory(f.plans[0].id, { p_city: 'US|CO|Boulder' })).total, 0)
  assert.equal((await f.directory(f.plans[0].id, { p_audience: 'athletes' })).total, 0)
  for (const table of ['outreach_campaigns', 'outreach_sync_state', 'outreach_leads', 'outreach_fetch_queue'] as const) {
    const result = await admin.from(table).select('*', { count: 'exact', head: true }).eq('client_id', f.tenant.client.id)
    assert.ifError(result.error); assert.equal(result.count, 0)
  }
  assert.equal((await admin.from('outreach_campaign_plans').update({ status: 'active' }).eq('id', f.plans[0].id)).error?.code, '23514')
  assert.equal((await admin.from('outreach_campaign_plans').update({ channel: 'email' }).eq('id', f.plans[2].id)).error?.code, '23514')
})

test('eligibility counts and rosters share verification, audience, hold, escrow and suppression checks', async t => {
  const f = await fixture(t)
  const rows = await f.insert([
    {}, { email_verification: 'unverified' }, { linkedin_verified: false },
    { review_evidence: { audience: 'hiring_partners', emailValidation: 'risky' } },
    { review_evidence: { audience: 'hiring_partners', emailValidation: 'unknown' } },
    { review_evidence: { audience: 'hiring_partners', emailValidation: 'valid', epmFitRanking: { classification: 'relationship_hold' } } },
    { review_evidence: { audience: 'hiring_partners', emailValidation: 'valid', epmFitRanking: { classification: 'identity_review_hold' } } },
    { review_evidence: { audience: 'hiring_partners', emailValidation: 'valid', epmFitRanking: { classification: 'eligibility_review_hold' } } },
    { review_evidence: { audience: 'hiring_partners', emailValidation: 'valid', epmFitRanking: { classification: 'evidence_needed' }, outreachAuthorized: false } },
    { review_state: 'escrow', review_reason: 'Held for review', reviewed_at: new Date().toISOString() },
    { review_evidence: { audience: 'athletes', emailValidation: 'valid' } },
  ])
  const counts = Object.fromEntries((await f.list()).map(p => [p.id, p.leadCount]))
  assert.equal(counts[f.plans[0].id], 5)
  assert.equal(counts[f.plans[1].id], 3)
  for (const p of f.plans) assert.equal((await f.directory(p.id)).total, counts[p.id])
  const campaign = await admin.from('outreach_campaigns').insert({ client_id: f.tenant.client.id, name: 'Synthetic mirror', provider_campaign_id: randomUUID() }).select('id').single()
  assert.ifError(campaign.error)
  assert.ifError((await admin.from('outreach_leads').insert({ client_id: f.tenant.client.id, campaign_id: campaign.data!.id, email: rows[0].email!, linkedin_url: rows[0].linkedin_url, status: 'unsubscribed' })).error)
  assert.equal((await f.directory(f.plans[0].id)).total, 4)
  assert.equal((await f.directory(f.plans[1].id)).total, 2)
  assert.ifError((await admin.from('outreach_imported_leads').update({ review_state: 'escrow', review_reason: 'Later hold', reviewed_at: new Date().toISOString() }).eq('id', rows[8].id)).error)
  assert.equal((await f.directory(f.plans[0].id)).total, 3)
  assert.equal((await f.directory(f.plans[1].id)).total, 1)
  const listed = await f.list()
  assert.equal(listed.find(p => p.id === f.plans[0].id)!.leadCount, 3)
  assert.equal(listed.find(p => p.id === f.plans[1].id)!.leadCount, 1)
  assert.equal((await f.tenant.supabase.rpc('list_outreach_leads_v2', { p_client_id: f.tenant.client.id })).data && true, true)
})

test('strict recovered mailboxes and LinkedIn only athletes retain their correct channels', async t => {
  const f = await fixture(t), email = 'recovery@example.test'
  const recovery = { email, provider: 'zerobounce', providerStatus: 'valid', providerVerifiedAt: '2026-10-22T17:00:00Z', catchall: false, freeEmail: false, identityMatched: true, currentEmployerMatched: true, employerDomainSupported: true, mailboxReceiptSha256: 'a'.repeat(64), identityReceiptSha256: 'b'.repeat(64), sourceReviewSha256: 'c'.repeat(64), sendAllowed: false }
  await f.insert([{ email, review_evidence: { emailValidation: 'unknown', emailRecovery: recovery } }])
  await f.insert([{ email: null, email_verification: 'unknown', email_verification_evidence: null, review_evidence: { audience: 'athletes' } }], [f.plans[2].id])
  assert.equal((await f.directory(f.plans[1].id)).leads[0].emailValidation, 'valid')
  const athlete = await f.directory(f.plans[2].id)
  assert.equal(athlete.total, 1); assert.equal(athlete.leads[0].email, null)
  assert.equal(athlete.leads[0].audience, 'athletes')
})

test('later evidence changes, bounced emails and suppressed conversations immediately remove eligible memberships', async t => {
  const f = await fixture(t)
  const [changed, bounced, suppressed] = await f.insert([{}, {}, {}])
  assert.ifError((await admin.from('outreach_imported_leads').update({ linkedin_verified: false, email_verification: 'unverified' }).eq('id', changed.id)).error)
  const campaign = await admin.from('outreach_campaigns').insert({ client_id: f.tenant.client.id, name: 'Synthetic bounce mirror', provider_campaign_id: randomUUID() }).select('id').single()
  assert.ifError(campaign.error)
  assert.ifError((await admin.from('outreach_leads').insert({ client_id: f.tenant.client.id, campaign_id: campaign.data!.id, email: bounced.email!, status: 'bounced' })).error)
  assert.ifError((await admin.from('outreach_conversations').insert({ client_id: f.tenant.client.id, channel: 'email', remote_conversation_id: randomUUID(), contact_address: suppressed.email!, suppressed: true })).error)
  assert.equal((await f.directory(f.plans[1].id)).total, 0)
  const network = await f.directory(f.plans[0].id)
  assert.equal(network.total, 1)
  assert.equal(network.leads[0].id, bounced.id)
  assert.equal((await f.list()).find(p => p.id === f.plans[0].id)!.leadCount, 1)
  assert.ifError((await admin.from('outreach_imported_leads').update({ review_evidence: { audience: 'athletes', emailValidation: 'valid' } }).eq('id', bounced.id)).error)
  assert.equal((await f.directory(f.plans[0].id)).total, 0)
  assert.equal((await f.list()).find(p => p.id === f.plans[0].id)!.leadCount, 0)
})

test('plan membership and personal location filtering precede pagination without duplicate people', async t => {
  const f = await fixture(t)
  await f.insert(Array.from({ length: 80 }, (_, i) => ({ first_name: `Person ${String(i).padStart(3, '0')}`, review_evidence: { audience: 'hiring_partners', emailValidation: 'valid', personLocation: { city: i < 76 ? 'Austin' : 'Boulder', state: i < 76 ? 'TX' : 'CO', country: 'US', status: 'known', matchMethod: 'exact_linkedin_and_name' } } })))
  await f.insert([{}], [])
  const page = await f.directory(f.plans[0].id, { p_state: 'US|TX', p_page: 1000000 })
  assert.equal(page.summary.total, 80)
  assert.equal(page.selectedPlan!.leadCount, 80)
  assert.equal(page.total, 76)
  assert.equal(page.page, 3)
  assert.equal(page.leads.length, 4)
  assert.equal(new Set(page.leads.map(row => row.id)).size, 4)
  assert.deepEqual(page.locationOptions.states.map(option => option.count).sort((a, b) => a - b), [4, 76])
  assert.equal((await f.directory(f.plans[1].id)).summary.total, 80)
})

test('tenant composite keys and raw grants prevent cross tenant membership and client writes', async t => {
  const a = await fixture(t), b = await fixture(t), outsider = await createAdmin(t), owner = await createAdmin(t)
  await grantOutreachOwner(owner.user.id)
  const [leadA] = await a.insert([{}]), [leadB] = await b.insert([{}])
  for (const membership of [
    { plan_id: a.plans[0].id, client_id: a.tenant.client.id, lead_id: leadB.id },
    { plan_id: b.plans[0].id, client_id: a.tenant.client.id, lead_id: leadA.id },
  ]) assert.equal((await admin.from('outreach_campaign_plan_memberships').insert(membership)).error?.code, '23503')
  assert.equal((await admin.from('outreach_campaign_plan_memberships').insert({ plan_id: a.plans[0].id, client_id: a.tenant.client.id, lead_id: leadA.id })).error?.code, '23505')
  for (const session of [a.tenant.supabase, b.tenant.supabase, outsider.supabase, owner.supabase, anonClient()]) {
    for (const table of ['outreach_campaign_plans', 'outreach_campaign_plan_memberships'] as const) {
      assert.ok((await session.from(table).select('*')).error)
      assert.ok((await session.from(table).delete().eq('client_id', a.tenant.client.id)).error)
    }
  }
  for (const session of [b.tenant.supabase, outsider.supabase, anonClient()]) {
    assert.equal((await session.rpc('list_outreach_campaign_plans', { p_client_id: a.tenant.client.id })).error?.code, '42501')
  }
  for (const p_plan of [b.plans[0].id, randomUUID()]) assert.equal((await a.tenant.supabase.rpc('list_outreach_leads_v2', { p_client_id: a.tenant.client.id, p_plan })).error?.code, '42501')
  for (const role of ['client_admin', 'client_member', 'client_viewer', 'operator'] as const) {
    assert.ifError((await admin.from('outreach_memberships').update({ role }).eq('user_id', a.tenant.user.id)).error)
    assert.equal((await a.list()).length, 3)
  }
  assert.ifError((await owner.supabase.rpc('list_outreach_campaign_plans', { p_client_id: a.tenant.client.id })).error)
  assert.ifError((await admin.from('outreach_memberships').update({ state: 'suspended' }).eq('user_id', a.tenant.user.id)).error)
  assert.equal((await a.tenant.supabase.rpc('list_outreach_campaign_plans', { p_client_id: a.tenant.client.id })).error?.code, '42501')
  assert.ifError((await admin.from('client_features').update({ enabled: false }).eq('client_id', a.tenant.client.id)).error)
  assert.equal((await owner.supabase.rpc('list_outreach_campaign_plans', { p_client_id: a.tenant.client.id })).error?.code, '42501')
})

test('real authenticated plan and lead endpoints preserve authorization and no store responses', async t => {
  const f = await fixture(t), foreign = await fixture(t)
  await f.insert([{}])
  const env = loadTestEnv(), config = { url: env.URL, anonKey: env.ANON, fetch }
  const token = (await f.tenant.supabase.auth.getSession()).data.session!.access_token
  const foreignToken = (await foreign.tenant.supabase.auth.getSession()).data.session!.access_token
  for (const [handler, path] of [[createOutboundCampaignPlanHandlers(config).GET, '/campaign-plans'], [createOutboundLeadHandlers(config).GET, '/leads']] as const) {
    const url = `https://api.invalid/api/outbound${path}?clientId=${f.tenant.client.id}${path === '/leads' ? '&planId=' + f.plans[0].id : ''}`
    const request = (bearer: string) => new Request(url, { headers: { authorization: `Bearer ${bearer}` } })
    const response = await handler(request(token))
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal((await handler(new Request(url))).status, 401)
    assert.equal((await handler(request(foreignToken))).status, 403)
    const body = await response.json() as Json
    assert.doesNotMatch(JSON.stringify(body), /provider_campaign|credential|source_sha256|emailRecovery/)
  }
})
