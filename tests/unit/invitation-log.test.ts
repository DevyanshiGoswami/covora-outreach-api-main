import assert from 'node:assert/strict'
import test from 'node:test'
import { createFailureReason, logInvitationEvent, maskEmail } from '../../src/lib/invitation-log'

test('invited addresses are masked and refusals keep their specific reason', () => {
  assert.equal(maskEmail('person@example.test'), 'p***@example.test')
  assert.equal(maskEmail('no-at-sign'), '***')
  assert.equal(maskEmail(null), null)
  assert.equal(createFailureReason({ code: '42501', message: 'Team access denied' }), 'not_allowed')
  assert.equal(createFailureReason({ code: '22023', message: 'Invalid invitation' }), 'invalid_email_or_role')
  assert.equal(createFailureReason({ code: '22023', message: 'Use membership management for current access' }), 'already_member')
  assert.equal(createFailureReason({ code: 'PGRST301' }), 'session_expired')
  assert.equal(createFailureReason({ code: 'XX000', message: 'anything else' }), 'database_error')
})

test('an event is logged without the full address, and a failed insert never throws', async t => {
  const lines: string[] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { lines.push(args.join(' ')) })
  const failing = { from: () => ({ insert: async () => { throw new Error('database down') } }) }
  await logInvitationEvent(failing as never, { step: 'inspect', outcome: 'failed', reason: 'different_account', invitee: 'person@example.test', detail: 'database code 42501' })
  await logInvitationEvent(null, { step: 'create', outcome: 'failed', reason: 'Not A Code!', invitee: 'person@example.test' })
  assert.equal(lines.length, 2)
  assert.ok(lines.every(line => line.startsWith('[invitation]') && line.includes('p***@example.test') && !line.includes('person@example.test')))
  assert.match(lines[0], /"reason":"different_account"/)
  assert.match(lines[1], /"reason":"unknown"/)
})
