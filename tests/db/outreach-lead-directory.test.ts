import { testProjectId, testDatabaseContainer } from '../helpers/stack.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { test, type TestContext } from 'node:test'
import type { Database } from '../../src/lib/database.types.ts'
import type { OutboundLeadDirectory } from '../../src/lib/outbound-leads-api.ts'
import { adminClient, anonClient } from '../helpers/admin.ts'
import { createAdmin, createTenant } from '../helpers/tenants.ts'
import { grantOutreachMembership, grantOutreachOwner } from '../helpers/outreach.ts'

const admin = adminClient()
type Lead = Database['public']['Tables']['outreach_leads']['Insert']
type Query = Database['public']['Functions']['list_outreach_leads']['Args']
async function fixture(t: TestContext) {
  const tenant = await createTenant(t, { features: ['outreach_app'] })
  await grantOutreachMembership(tenant.user.id, tenant.client.id, 'client_viewer')
  const campaign = await admin.from('outreach_campaigns').insert({ client_id: tenant.client.id, name: 'Synthetic outreach', provider_campaign_id: randomUUID() }).select('id').single()
  assert.ifError(campaign.error)
  const insert = async (rows: Partial<Lead>[]) => {
    const result = await admin.from('outreach_leads').insert(rows.map((row, index) => ({
      client_id: tenant.client.id, campaign_id: campaign.data!.id, email: `fixture-${index}-${randomUUID()}@example.test`, email_verification: 'unknown', ...row,
    }))).select('id')
    assert.ifError(result.error)
    return result.data!.map(row => row.id)
  }
  const list = async (query: Omit<Query, 'p_client_id'> = {}) => {
    const result = await tenant.supabase.rpc('list_outreach_leads', { p_client_id: tenant.client.id, ...query })
    assert.ifError(result.error)
    return result.data as unknown as OutboundLeadDirectory
  }
  return { tenant, campaignId: campaign.data!.id, insert, list }
}

test('lead directory respects current membership, feature gates and explicit agency access; raw tables stay denied', async t => {
  const own = await fixture(t)
  const foreign = await fixture(t)
  const unset = await createAdmin(t)
  const owner = await createAdmin(t)
  await grantOutreachOwner(owner.user.id)
  await own.insert([{ first_name: 'Tenant A', provider_lead_id: 'private-provider-identity' }])
  await foreign.insert([{ first_name: 'Foreign secret' }])
  assert.equal((await own.list()).leads.length, 1)
  for (const session of [own.tenant.supabase, foreign.tenant.supabase, unset.supabase, anonClient()]) {
    assert.ok((await session.from('outreach_leads').select('*')).error)
    assert.ok((await session.from('outreach_leads').update({ email_verification: 'verified' }).eq('client_id', own.tenant.client.id)).error)
  }
  for (const session of [foreign.tenant.supabase, unset.supabase, anonClient()]) {
    assert.equal((await session.rpc('list_outreach_leads', { p_client_id: own.tenant.client.id })).error?.code, '42501')
  }
  assert.ifError((await owner.supabase.rpc('list_outreach_leads', { p_client_id: own.tenant.client.id })).error)
  assert.ifError((await admin.from('outreach_memberships').update({ state: 'revoked' }).eq('user_id', own.tenant.user.id)).error)
  assert.equal((await own.tenant.supabase.rpc('list_outreach_leads', { p_client_id: own.tenant.client.id })).error?.code, '42501')
  assert.ifError((await admin.from('client_features').update({ enabled: false }).eq('client_id', own.tenant.client.id)).error)
  assert.equal((await owner.supabase.rpc('list_outreach_leads', { p_client_id: own.tenant.client.id })).error?.code, '42501')
})

test('lead directory only exposes neutral assigned fields and keeps existing results projection unchanged', async t => {
  const f = await fixture(t)
  const [id] = await f.insert([{ first_name: 'Jane', last_name: 'Sample', company: 'Acme', job_title: 'CEO', location: 'Austin',
    linkedin_url: 'https://www.linkedin.com/in/jane-sample', email_verification: 'verified', role_category: 'owners-executives', provider_lead_id: 'private-provider-identity' }])
  const page = await f.list()
  assert.equal(page.clientId, f.tenant.client.id)
  assert.deepEqual(page.summary, { total: 1, verifiedEmail: 1, withLinkedIn: 1, companies: 1 })
  assert.deepEqual(page.companies, ['Acme'])
  assert.deepEqual(page.campaigns, [{ id: f.campaignId, name: 'Synthetic outreach' }])
  assert.equal(page.leads[0].id, id)
  assert.equal(page.leads[0].fullName, 'Jane Sample')
  assert.equal(page.leads[0].linkedinVerified, null)
  assert.doesNotMatch(JSON.stringify(page), /private-provider-identity|provider_/)
  const old = await f.tenant.supabase.from('client_outreach_leads').select('*')
  assert.ifError(old.error)
  assert.equal(old.data?.length, 1)
  assert.equal('job_title' in old.data![0], false)
  assert.equal('linkedin_url' in old.data![0], false)
})

test('server search and AND filters cover profile, campaign, verification, role and status across all leads', async t => {
  const f = await fixture(t)
  const other = await admin.from('outreach_campaigns').insert({ client_id: f.tenant.client.id, name: 'Second campaign', provider_campaign_id: randomUUID() }).select('id').single()
  assert.ifError(other.error)
  const ids = await f.insert([
    { first_name: 'Jane', last_name: 'First', company: 'Acme', job_title: 'CEO', location: 'Austin', email: 'jane@example.test', email_verification: 'verified', linkedin_url: 'https://www.linkedin.com/in/jane', linkedin_verified: true, role_category: 'owners-executives', status: 'in_sequence' },
    { first_name: 'Alex', last_name: 'Second', company: 'Acme', job_title: 'Director', email_verification: 'unverified', linkedin_url: 'https://www.linkedin.com/in/alex', role_category: 'vp-director', status: 'replied', campaign_id: other.data!.id },
    { first_name: 'Sam', company: 'Beta', job_title: null, email_verification: 'unknown', status: 'completed' },
    { first_name: 'Percent%literal', company: 'Gamma', status: 'not_contacted' },
  ])
  for (const q of ['Jane First', 'CEO', 'Austin', 'jane@example.test', 'linkedin.com/in/jane']) assert.deepEqual((await f.list({ p_q: q })).leads.map(row => row.id), [ids[0]])
  assert.deepEqual((await f.list({ p_q: 'Second campaign' })).leads.map(row => row.id), [ids[1]])
  assert.equal((await f.list({ p_q: '%' })).total, 1)
  const exact = await f.list({ p_q: 'Jane', p_company: 'aCmE', p_campaign: f.campaignId, p_role: 'owners-executives', p_email: 'verified', p_linkedin: 'verified', p_status: 'contacted' })
  assert.deepEqual(exact.leads.map(row => row.id), [ids[0]])
  assert.equal(exact.total, 1)
  assert.equal(exact.summary.total, 4)
  assert.equal((await f.list({ p_q: 'Jane', p_role: 'vp-director' })).total, 0)
  assert.equal((await f.list({ p_email: 'available' })).total, 4)
  assert.equal((await f.list({ p_email: 'verified' })).total, 1)
  assert.equal((await f.list({ p_linkedin: 'available' })).total, 2)
  assert.equal((await f.list({ p_linkedin: 'verified' })).total, 1)
  assert.equal((await f.list({ p_role: 'manager-other' })).total, 2)
  assert.equal((await f.list({ p_campaign: randomUUID() })).total, 0)
  for (const status of ['not_contacted', 'replied', 'completed']) assert.equal((await f.list({ p_status: status })).total, 1)
})

test('deterministic 36-row pagination, sorting, empty states and excessive page clamping', async t => {
  const f = await fixture(t)
  const empty = await f.list({ p_page: 1000000 })
  assert.equal(empty.page, 1)
  assert.deepEqual(empty.leads, [])
  assert.deepEqual(empty.summary, { total: 0, verifiedEmail: 0, withLinkedIn: 0, companies: 0 })
  await f.insert(Array.from({ length: 80 }, (_, index) => ({ first_name: `Person ${String(index).padStart(3, '0')}`, company: index % 2 ? 'B' : 'A', job_title: index % 3 ? 'Manager' : 'Director' })))
  for (const sort of ['company', 'name', 'role']) {
    const first = await f.list({ p_sort: sort })
    const second = await f.list({ p_sort: sort, p_page: 2 })
    const last = await f.list({ p_sort: sort, p_page: 1000000 })
    assert.equal(first.leads.length, 36)
    assert.equal(second.leads.length, 36)
    assert.equal(last.leads.length, 8)
    assert.equal(last.page, 3)
    assert.equal(new Set([...first.leads, ...second.leads, ...last.leads].map(row => row.id)).size, 80)
    assert.deepEqual((await f.list({ p_sort: sort })).leads.map(row => row.id), first.leads.map(row => row.id))
  }
  assert.equal((await f.list({ p_sort: 'name' })).leads[0].fullName, 'Person 000')
  assert.equal((await f.list({ p_sort: 'role' })).leads[0].jobTitle, 'Director')
})

test('large-workspace company facets are bounded honestly and retain selected options while counts/search remain global', async t => {
  const f = await fixture(t)
  for (let offset = 0; offset < 1002; offset += 500) {
    await f.insert(Array.from({ length: Math.min(500, 1002 - offset) }, (_, i) => ({ company: `Company ${String(offset + i).padStart(4, '0')}`, first_name: `Person ${offset + i}` })))
  }
  const first = await f.list()
  assert.equal(first.total, 1002)
  assert.equal(first.summary.companies, 1002)
  assert.equal(first.companies.length, 1000)
  assert.equal(first.filterOptionsTruncated, true)
  const selected = await f.list({ p_company: 'Company 1001' })
  assert.equal(selected.total, 1)
  assert.equal(selected.companies.length, 1001)
  assert.ok(selected.companies.includes('Company 1001'))
  assert.equal((await f.list({ p_q: 'Company 1001' })).total, 1)
})

test('RPC independently rejects malformed filters and schema rejects unsafe profile links or manufactured evidence', async t => {
  const f = await fixture(t)
  for (const input of [{ p_page: 0 }, { p_page: 1000001 }, { p_role: 'owner' }, { p_email: 'true' }, { p_linkedin: 'yes' }, { p_status: 'anything' }, { p_sort: 'email;drop' }, { p_q: 'a'.repeat(201) }, { p_company: 'a'.repeat(501) }]) {
    assert.equal((await f.tenant.supabase.rpc('list_outreach_leads', { p_client_id: f.tenant.client.id, ...input })).error?.code, '22023')
  }
  for (const values of [{ linkedin_url: 'javascript:alert(1)' }, { linkedin_url: 'https://evil.test/in/person' }, { linkedin_url: 'https://www.linkedin.com/in/person?redirect=evil' }, { linkedin_verified: true }, { email_verification: 'yes' }, { role_category: 'chief' }]) {
    const inserted = await admin.from('outreach_leads').insert({ client_id: f.tenant.client.id, campaign_id: f.campaignId, email: 'invalid@example.test', ...values })
    assert.equal(inserted.error?.code, '23514')
  }
  const label = execFileSync('docker', ['inspect', '--format', '{{index .Config.Labels "com.supabase.cli.project"}}', testDatabaseContainer], { encoding: 'utf8' }).trim()
  assert.equal(label, testProjectId)
  const sql = "select prosecdef and proconfig @> array['search_path=pg_catalog, public, pg_temp'] and has_function_privilege('authenticated',oid,'EXECUTE') and not has_function_privilege('anon',oid,'EXECUTE') and not has_function_privilege('service_role',oid,'EXECUTE') from pg_proc where proname='list_outreach_leads';"
  assert.equal(execFileSync('docker', ['exec', testDatabaseContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atq', '-c', sql], { encoding: 'utf8' }).trim(), 't')
})

test('malformed older email rows are unavailable with unknown verification and display values are bounded', async t => {
  const f = await fixture(t)
  await f.insert([
    { email: 'not an email', email_verification: 'verified', first_name: 'a'.repeat(800), last_name: 'b'.repeat(800), company: 'c'.repeat(800) },
    { email: `${'a'.repeat(250)}@example.test`, email_verification: 'verified' },
    { email: 'good@example.test', email_verification: 'verified' },
  ])
  const page = await f.list()
  assert.equal(page.summary.verifiedEmail, 1)
  assert.equal((await f.list({ p_email: 'available' })).total, 1)
  assert.equal((await f.list({ p_email: 'verified' })).total, 1)
  assert.equal(page.leads.filter(lead => lead.email === null && lead.emailVerification === 'unknown').length, 2)
  for (const lead of page.leads) for (const value of [lead.company, lead.firstName, lead.lastName, lead.fullName]) assert.ok(value.length <= 500)
})

test('campaign facets retain a selected authorized campaign beyond the bounded options', async t => {
  const f = await fixture(t)
  const inserted = await admin.from('outreach_campaigns').insert(Array.from({ length: 502 }, (_, index) => ({
    client_id: f.tenant.client.id, name: `Campaign ${String(index).padStart(4, '0')}`, provider_campaign_id: randomUUID(),
  }))).select('id,name')
  assert.ifError(inserted.error)
  await f.insert(inserted.data!.map(campaign => ({ campaign_id: campaign.id, first_name: campaign.name })))
  const page = await f.list()
  assert.equal(page.total, 502)
  assert.equal(page.campaigns.length, 500)
  assert.equal(page.filterOptionsTruncated, true)
  const selected = inserted.data!.find(row => row.name === 'Campaign 0501')!.id
  const filtered = await f.list({ p_campaign: selected })
  assert.equal(filtered.total, 1)
  assert.equal(filtered.campaigns.length, 501)
  assert.ok(filtered.campaigns.some(campaign => campaign.id === selected))
  assert.equal((await f.list({ p_q: 'Campaign 0501' })).total, 1)
})

test('historical control characters cannot poison names, details, campaign labels or workspace-wide facets', async t => {
  const f = await fixture(t)
  assert.ifError((await admin.from('outreach_campaigns').update({ name: 'Dirty\u001f  campaign\tlabel' }).eq('id', f.campaignId)).error)
  await f.insert([
    { first_name: 'Jane\u001f', last_name: '\tSample\u007f', company: 'Acme\u001f  Corp', job_title: 'Chief\u001f  Executive', location: 'Austin\n TX', interest: 'Interested\u001f', email: 'jane@example.test' },
    { first_name: 'Clean', company: 'Beta', email: 'clean@example.test' },
  ])
  const page = await f.list({ p_q: 'jane' })
  assert.equal(page.leads[0].firstName, 'Jane')
  assert.equal(page.leads[0].lastName, 'Sample')
  assert.equal(page.leads[0].fullName, 'Jane Sample')
  assert.equal(page.leads[0].company, 'Acme Corp')
  assert.equal(page.leads[0].jobTitle, 'Chief Executive')
  assert.equal(page.leads[0].location, 'Austin TX')
  assert.equal(page.leads[0].interest, 'Interested')
  assert.equal(page.leads[0].campaignName, 'Dirty campaign label')
  const unrelated = await f.list({ p_q: 'clean' })
  assert.equal(unrelated.total, 1)
  assert.ok(unrelated.companies.includes('Acme Corp'))
  assert.equal(unrelated.campaigns[0].name, 'Dirty campaign label')
  assert.equal((await f.list({ p_company: 'Acme Corp' })).total, 1)
  assert.equal((await f.list({ p_q: 'Chief Executive' })).total, 1)
})
