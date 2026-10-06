import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { InstantlyEmail, InstantlyLeadPageItem } from '../../src/lib/instantly.ts'
import {
  leadForAssignment, messageForAssignment, neutralThreadKey, normalizedSchedule, normalizedTotals,
  replyCheckpoint, replyPlainText, retryDelayMs, safeOutreachText, sequencePlainText, syncDue,
} from '../../src/lib/outreach-sync-data.ts'

const assignment = { id: 'internal-campaign', client_id: 'tenant-a', provider_campaign_id: 'provider-campaign' }
const email: InstantlyEmail = {
  id: 'remote-message', campaign_id: assignment.provider_campaign_id, thread_id: 'remote-thread',
  timestamp_created: '2026-09-01T01:00:00Z', timestamp_email: '2026-09-01T01:00:00Z',
  subject: 'Re: hello', from_address_email: 'lead@example.com', to_address_email_list: 'sender@example.com',
  body: { text: 'Interested!\n\nOn Tue, Someone wrote:\n> prior email', html: '<img src="https://tracking.example/pixel">' },
  eaccount: 'sender@example.com', ue_type: 2,
}

test('reply mapping uses only the database assignment and rejects unassigned or mismatched campaigns', () => {
  assert.equal(messageForAssignment(null, email), null)
  assert.equal(messageForAssignment(assignment, { ...email, campaign_id: 'another-campaign' }), null)
  assert.equal(messageForAssignment(assignment, { ...email, campaign_id: null }), null)
  const mapped = messageForAssignment(assignment, { ...email, client_id: 'tenant-b' } as InstantlyEmail)
  assert.equal(mapped?.client_id, 'tenant-a')
  assert.equal(mapped?.campaign_id, assignment.id)
  assert.equal(mapped?.body_text, 'Interested!')
  assert.equal('client_read_at' in mapped!, false, 'sync cannot overwrite a reader-owned mark')
  assert.equal('html' in mapped!, false)
  assert.equal(mapped?.thread_key.includes('remote-thread'), false)
})

test('unknown direction, scheduled messages and invalid timestamps fail safe', () => {
  for (const ue_type of [null, undefined, 0, 4, 99]) assert.equal(messageForAssignment(assignment, { ...email, ue_type }), null)
  assert.equal(messageForAssignment(assignment, { ...email, timestamp_email: 'bad' }), null)
  assert.equal(messageForAssignment(assignment, { ...email, ue_type: 3 })?.direction, 'sent')
})

test('HTML-only replies never become stored content; sequence markup and tracking are discarded', () => {
  assert.equal(replyPlainText({ html: '<p>secret html only</p>' }), '')
  assert.equal(sequencePlainText('<p>Hello &amp; welcome</p><img src="https://pixel.example"><script>bad()</script><div>Thanks</div>'), 'Hello & welcome\nThanks')
  assert.equal(sequencePlainText('&lt;img src=x&gt;Hello'), 'Hello')
  assert.doesNotMatch(safeOutreachText('Built in Instantly 0c30ce8f-d671-4c93-a819-112a8ff7b12a'), /instantly|0c30ce8f/i)
  assert.doesNotMatch(safeOutreachText('MyInstantlySequence instantly_campaign'), /instantly/i)
})

test('thread keys are deterministic internal UUIDs scoped to the campaign', () => {
  const key = neutralThreadKey('campaign-a', 'provider-thread')
  assert.match(key, /^[0-9a-f-]{36}$/)
  assert.equal(key, neutralThreadKey('campaign-a', 'provider-thread'))
  assert.notEqual(key, neutralThreadKey('campaign-b', 'provider-thread'))
})

test('oldest backfill pages keep the original watermark until the final page succeeds', () => {
  const scanStartedAt = '2026-10-01T00:00:00Z'
  const first = replyCheckpoint({ cursor: null, watermark: null, scanStartedAt, nextCursor: 'page2', itemCount: 100 })
  assert.deepEqual(first, { reply_cursor: 'page2', reply_watermark: null, reply_scan_started_at: scanStartedAt })
  const final = replyCheckpoint({ cursor: 'page2', watermark: null, scanStartedAt, itemCount: 3 })
  assert.deepEqual(final, { reply_cursor: null, reply_watermark: scanStartedAt, reply_scan_started_at: null })
  assert.throws(() => replyCheckpoint({ cursor: 'stuck', watermark: null, scanStartedAt, nextCursor: 'stuck', itemCount: 100 }), /repeated/)
  assert.equal(replyCheckpoint({ cursor: 'empty', watermark: null, scanStartedAt, nextCursor: 'empty', itemCount: 0 }).reply_cursor, null)
})

test('new fields cannot leak through schedule or totals JSON and auto replies are counted exactly once', () => {
  const totals = normalizedTotals({ reply_count_unique: 9, reply_count_automatic_unique: 2, provider_id: 'secret' })
  assert.equal(totals.unique_replies, 11)
  assert.equal(totals.unique_auto_replies, 2)
  assert.equal('provider_id' in totals, false)
  assert.deepEqual(normalizedSchedule({ provider_id: 'secret', schedules: [{ name: 'Instantly setup',
    timezone: 'UTC', timing: { from: '09:00', to: '17:00' }, days: { '1': true, '2': false, evil: true } }] }),
  { windows: [{ timezone: 'UTC', from: '09:00', to: '17:00', days: [1] }] })
})

test('leads use assignment tenancy, reject absent emails and never guess step numbers from UUIDs', () => {
  const lead: InstantlyLeadPageItem = { email: 'LEAD@example.com', status: 1, email_open_count: 0,
    email_reply_count: 0, email_click_count: 0, lt_interest_status: null, last_step_id: 'remote-step-uuid' }
  assert.equal(leadForAssignment(null, lead), null)
  assert.equal(leadForAssignment(assignment, { ...lead, email: null }), null)
  assert.equal(leadForAssignment(assignment, { ...lead, campaign: 'other' }), null)
  assert.equal(leadForAssignment(assignment, lead)?.client_id, 'tenant-a')
  assert.equal(leadForAssignment(assignment, lead)?.last_step, null)
  assert.equal(leadForAssignment(assignment, lead)?.email, 'lead@example.com')
})

test('cadences and retry delays are bounded and deterministic', () => {
  assert.equal(syncDue(null, 1000, 5000), true)
  assert.equal(syncDue(new Date(4000).toISOString(), 1000, 5000), true)
  assert.equal(syncDue(new Date(4500).toISOString(), 1000, 5000), false)
  assert.equal(retryDelayMs(1), 60_000)
  assert.equal(retryDelayMs(100), 3_600_000)
})
