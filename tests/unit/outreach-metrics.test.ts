import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bounceRate, campaignStatus, interestLabel, leadStatus, positiveRate, replyRate,
  stripVendorFooter, trimQuotedReply } from '../../src/lib/outreach-metrics.ts'

test('outreach rates subtract auto replies exactly once and guard empty or malformed denominators', () => {
  assert.equal(replyRate(14, 4, 100), 0.1)
  assert.equal(replyRate(0, 5, 100), 0)
  assert.equal(replyRate(20, 0, 0), 0)
  assert.equal(replyRate(20, 0, Number.NaN), 0)
  assert.equal(positiveRate(3, 10), 0.3)
  assert.equal(bounceRate(2, 50), 0.04)
  assert.equal(bounceRate(100, 50), 1)
  assert.equal(bounceRate(-1, 50), 0)
})

test('outreach statuses have neutral fallbacks and terminal delivery states take precedence', () => {
  assert.equal(campaignStatus(1), 'active')
  assert.equal(campaignStatus(900), 'unknown')
  assert.equal(leadStatus(-1, 1), 'bounced')
  assert.equal(leadStatus(1, 2), 'replied')
  assert.equal(leadStatus(1), 'not_contacted')
  assert.equal(leadStatus(1, 0, '2026-10-02T00:00:00Z'), 'in_sequence')
  assert.equal(leadStatus(3), 'completed')
  assert.equal(campaignStatus(4), 'running_subsequences')
  assert.equal(interestLabel(0), 'Out of office')
  assert.equal(interestLabel(null), 'Not classified')
  assert.equal(interestLabel(1), 'Interested')
})

test('quoted history is removed for Gmail, wrapped headers, Outlook and forwarded replies', () => {
  for (const quote of ['On Tue, Sep 1, Alex wrote:\nOld text',
    'On Tue, Sep 1,\nAlex <alex@example.com>\nwrote:\nOld text',
    '> Old text', '-----Original Message-----\nOld text',
    'From: Alex\nSent: Tuesday\nTo: Pat\nSubject: Old text']) {
    assert.equal(trimQuotedReply(`Yes, next week works.\r\n\r\n${quote}`), 'Yes, next week works.')
  }
  assert.equal(trimQuotedReply('On Tuesday we wrote a proposal.\nCan you review it?'),
    'On Tuesday we wrote a proposal.\nCan you review it?')
  assert.equal(trimQuotedReply('From: the heart.\nThanks.'), 'From: the heart.\nThanks.')
})

test('vendor footers are stripped while legitimate lead requests remain', () => {
  assert.equal(stripVendorFooter('Please unsubscribe me.\n\nSent with Instantly.ai'), 'Please unsubscribe me.')
  assert.equal(stripVendorFooter('Thanks\nPowered by Instantly\nhttps://instantly.ai'), 'Thanks')
  assert.equal(stripVendorFooter('Thanks\nUnsubscribe: https://app.instantly.ai/unsubscribe/123'), 'Thanks')
  assert.equal(stripVendorFooter('No HTML is interpreted: <img src="x">'), 'No HTML is interpreted: <img src="x">')
})
