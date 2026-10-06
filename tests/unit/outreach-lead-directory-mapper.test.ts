import assert from 'node:assert/strict'
import test from 'node:test'
import { leadEmailVerification, leadForAssignment, leadLinkedInUrl } from '../../src/lib/outreach-sync-data.ts'
import type { InstantlyLeadPageItem } from '../../src/lib/instantly.ts'
import { roleFilterCategory } from '../../src/lib/lead-role-filter.ts'

const assignment = { id: 'local-campaign', client_id: 'tenant', provider_campaign_id: 'private-campaign' }
const lead: InstantlyLeadPageItem = { campaign: 'private-campaign', email: 'lead@example.test', status: 1, email_open_count: 0, email_reply_count: 0, email_click_count: 0, lt_interest_status: null }

test('verification is native explicit evidence only, never inferred from presence, strings or custom flags', () => {
  assert.equal(leadEmailVerification(1), 'verified')
  for (const value of [-1, -2, -3, -4]) assert.equal(leadEmailVerification(value), 'unverified')
  for (const value of [0, 11, 12, 99, '1', 'verified', null, undefined, true, {}]) assert.equal(leadEmailVerification(value), 'unknown')
  const row = leadForAssignment(assignment, { ...lead, payload: { email_verified: true, linkedin_verified: true, verification_status: 1 } })!
  assert.equal(row.email_verification, 'unknown')
  assert.equal(row.linkedin_verified, null)
  assert.equal(row.linkedin_url, null)
  assert.equal(row.role_category, null)
})

test('known profile custom fields are normalized without retaining arbitrary payload or markup', () => {
  const row = leadForAssignment(assignment, { ...lead, job_title: 'CEO', company_name: 'Acme', verification_status: 1, payload: {
    jobTitle: 'Not CEO', location: '<b>Austin</b><script>secret()</script>', linkedin_url: 'http://linkedin.com/in/jane-sample/?tracking=private#fragment',
    unexpected_secret: 'do-not-copy', provider_id: 'do-not-copy', linkedin_verified: true,
  } })!
  assert.equal(row.job_title, 'CEO')
  assert.equal(row.location, 'Austin')
  assert.equal(row.linkedin_url, 'https://www.linkedin.com/in/jane-sample')
  assert.equal(row.linkedin_verified, null)
  assert.equal(row.email_verification, 'verified')
  assert.equal(row.role_category, 'owners-executives')
  assert.doesNotMatch(JSON.stringify(row), /do-not-copy|tracking|secret\(\)|<b>/)
  assert.equal(leadForAssignment(assignment, { ...lead, payload: { jobTitle: 'VP Sales', location: ['wrong'] } })?.role_category, 'vp-director')
  assert.equal(leadForAssignment(assignment, { ...lead, payload: { job_title: 'Account Manager', location: 42 } })?.location, null)
  assert.equal(leadForAssignment(assignment, { ...lead, payload: { title: 'a'.repeat(501) } })?.job_title?.length, 500)
})

test('LinkedIn normalization permits only canonical individual profile paths', () => {
  for (const value of ['https://www.linkedin.com/in/jane/', 'http://linkedin.com/in/jane', 'https://uk.linkedin.com/in/jane?track=x']) assert.equal(leadLinkedInUrl(value), 'https://www.linkedin.com/in/jane')
  for (const value of ['javascript:alert(1)', 'https://linkedin.com.evil.test/in/jane', 'https://evil.test/linkedin.com/in/jane', 'https://user:secret@www.linkedin.com/in/jane', 'https://www.linkedin.com:444/in/jane', 'https://www.linkedin.com/company/jane', 'https://www.linkedin.com/in/jane/messages', 'https://www.linkedin.com/in/%2f..', '//linkedin.com/in/jane', '', {}, null]) assert.equal(leadLinkedInUrl(value), null)
})

test('role categories retain legacy conservative leadership grouping instead of executive keyword matches', () => {
  for (const title of ['CEO', 'Co-founder', 'President', 'Managing Partner', 'Chief Revenue Officer']) assert.equal(roleFilterCategory(title), 'owners-executives')
  for (const title of ['Vice President Sales', 'Director of Marketing', 'Head of Growth']) assert.equal(roleFilterCategory(title), 'vp-director')
  for (const title of ['Executive Assistant', 'Product Owner', 'Advisor to CEO', 'Head Chef', 'Account Manager', '']) assert.equal(roleFilterCategory(title), 'manager-other')
  const row = leadForAssignment(assignment, { ...lead, company_name: 'Founder Labs', job_title: 'Account Manager at Founder Labs' })!
  assert.equal(row.role_category, 'manager-other')
  assert.equal(row.job_title, 'Account Manager at Founder Labs')
})

test('imported control characters are normalized in profile display text and explicit name aliases', () => {
  const row = leadForAssignment(assignment, { ...lead, payload: { firstName: 'Jane\u001f', lastName: 'Sample\u007f', companyName: 'Acme\u001f  Corp', jobTitle: 'Chief\u001f  Executive', location: 'Austin\nTX' } })!
  assert.equal(row.first_name, 'Jane')
  assert.equal(row.last_name, 'Sample')
  assert.equal(row.company, 'Acme Corp')
  assert.equal(row.job_title, 'Chief Executive')
  assert.equal(row.location, 'Austin TX')
})
