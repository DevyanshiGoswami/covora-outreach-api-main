import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareLegacyLeadImport } from '../../src/lib/outreach-lead-import.ts'

const scope = { clientId: '4bc346df-4530-4436-ad91-dcf92b9ec776', listId: '5a3f2313-a651-4c74-ae2f-ec6a0fc8e86c' }
const contact = { firstName: 'Jane', lastName: 'Sample', title: 'CEO', company: 'Example', location: 'Austin, TX', email: 'jane@example.test', linkedinUrl: 'https://www.linkedin.com/in/jane-sample?test=1', verified: true, verifiedReason: 'Source confirmed current role on an earlier check.' }

test('reviewed legacy adapter preserves historical profile evidence without inventing email verification', () => {
  const result = prepareLegacyLeadImport([{ ...contact, emailVerification: 'verified', provider_lead_id: 'private' }], scope)
  assert.deepEqual(result.summary, { input: 1, imported: 1, duplicates: 0, invalidEmail: 0, unavailableLinkedIn: 0, verifiedEmail: 0, verifiedLinkedIn: 1 })
  assert.equal(result.rows[0].email_verification, 'unknown')
  assert.equal(result.rows[0].email_verification_evidence, null)
  assert.equal(result.rows[0].linkedin_verified, true)
  assert.match(result.rows[0].linkedin_verification_evidence!, /^Imported prior source check:/)
  assert.equal(result.rows[0].linkedin_url, 'https://www.linkedin.com/in/jane-sample')
  assert.equal(result.rows[0].status, 'not_contacted')
  assert.equal(result.rows[0].role_category, 'owners-executives')
  assert.equal('campaign_id' in result.rows[0], false)
  assert.equal('provider_lead_id' in result.rows[0], false)
  assert.equal(prepareLegacyLeadImport([contact], scope).rows[0].id, result.rows[0].id)
  assert.notEqual(prepareLegacyLeadImport([contact], { ...scope, listId: scope.clientId }).rows[0].id, result.rows[0].id)
})

test('email/profile deduplication is deterministic and isolated to one supplied list', () => {
  const result = prepareLegacyLeadImport([contact, { ...contact, email: ' JANE@EXAMPLE.TEST ' }, { ...contact, email: 'other@example.test' }], scope)
  assert.equal(result.rows.length, 1)
  assert.equal(result.summary.duplicates, 2)
  assert.equal(result.rows[0].email, 'jane@example.test')
})

test('unsafe or unsupported links do not discard contacts or retain fake profile verification', () => {
  for (const linkedinUrl of ['javascript:alert(1)', 'https://evil.test/in/jane', 'https://user:secret@linkedin.com/in/jane', 'https://linkedin.com/in/jan%C3%A9']) {
    const row = prepareLegacyLeadImport([{ ...contact, linkedinUrl }], scope).rows[0]
    assert.equal(row.linkedin_url, null)
    assert.equal(row.linkedin_verified, null)
    assert.equal(row.linkedin_verification_evidence, null)
    assert.equal(row.email, contact.email)
  }
  for (const fields of [{ verified: false }, { verifiedReason: '' }, { verified: undefined }]) {
    assert.equal(prepareLegacyLeadImport([{ ...contact, ...fields }], scope).rows[0].linkedin_verified, null)
  }
})

test('invalid contacts fail neutrally; imported display text is normalized and bounded', () => {
  const row = prepareLegacyLeadImport([{ ...contact, firstName: 'Jane\u001f\tSample', title: 'a'.repeat(1000), email: 'invalid address' }], scope).rows[0]
  assert.equal(row.first_name, 'Jane Sample')
  assert.equal(row.job_title?.length, 500)
  assert.equal(row.email, null)
  for (const input of [[], [{ ...contact, email: null, linkedinUrl: 'bad' }], [{ firstName: 'Secret' }]]) {
    assert.throws(() => prepareLegacyLeadImport(input, scope), /^(Error: )?(Invalid lead import schema or target\.|A lead is missing a stable contact identity\.)$/)
  }
})
