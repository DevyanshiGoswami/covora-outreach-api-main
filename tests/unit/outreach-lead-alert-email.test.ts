import test from 'node:test'
import assert from 'node:assert/strict'

import { renderLeadAlertEmail } from '../../src/lib/outreach-lead-alert-email.ts'

const validInput = {
  leadCount: 5,
  clientId: '55555555-5555-5555-5555-555555555555',
  portalOrigin: 'https://portal.example.com',
}
const body = 'Head to your Covora portal to see their replies and keep the conversation going.'
const portalUrl = `${validInput.portalOrigin}/?client=${validInput.clientId}&view=inbox`

test('lead alerts use the approved plural copy in HTML, plain text, and subject', () => {
  const email = renderLeadAlertEmail(validInput)
  const headline = 'You have 5 new leads that want to hear from you!'
  assert.equal(email.subject, headline)
  assert.ok(email.html.includes(headline))
  assert.ok(email.html.includes(body))
  assert.match(email.html, />View your leads<\/a>/)
  assert.ok(email.text.includes(headline))
  assert.ok(email.text.includes(body))
  assert.ok(email.text.includes(`View your leads: ${portalUrl}`))
})

test('one lead uses singular grammar', () => {
  const email = renderLeadAlertEmail({ ...validInput, leadCount: 1 })
  const headline = 'You have 1 new lead that wants to hear from you!'
  assert.equal(email.subject, headline)
  assert.ok(email.html.includes(headline))
  assert.ok(email.text.includes(headline))
})

test('the only link targets the tenant inbox and escapes its HTML attribute', () => {
  const email = renderLeadAlertEmail(validInput)
  const hrefs = [...email.html.matchAll(/href="([^"]+)"/g)]
  assert.equal(hrefs.length, 1)
  assert.equal(hrefs[0][1], portalUrl.replace('&', '&amp;'))
  const parsed = new URL(hrefs[0][1].replace('&amp;', '&'))
  assert.equal(parsed.origin, validInput.portalOrigin)
  assert.equal(parsed.pathname, '/')
  assert.deepEqual([...parsed.searchParams], [
    ['client', validInput.clientId],
    ['view', 'inbox'],
  ])
  assert.equal(parsed.hash, '')
  assert.ok(!email.text.includes('&amp;'))
})

test('an origin with a trailing slash produces the same safe link', () => {
  assert.deepEqual(
    renderLeadAlertEmail({ ...validInput, portalOrigin: `${validInput.portalOrigin}/` }),
    renderLeadAlertEmail(validInput),
  )
})

test('lead alerts reject counts outside the bounded integer range', () => {
  for (const leadCount of [0, -1, 1.5, 10_001, NaN, Infinity, -Infinity, '5', null]) {
    assert.throws(
      () => renderLeadAlertEmail({ ...validInput, leadCount: leadCount as number }),
      /lead count/i,
      String(leadCount),
    )
  }
  assert.match(renderLeadAlertEmail({ ...validInput, leadCount: 10_000 }).subject, /10000 new leads/)
})

test('lead alerts reject malformed client IDs and query or attribute injection', () => {
  for (const clientId of [
    '',
    'not-a-uuid',
    ` ${validInput.clientId}`,
    `${validInput.clientId}\n`,
    `${validInput.clientId}&view=admin`,
    `${validInput.clientId}" onclick="alert(1)`,
    '<script>alert(1)</script>',
    null,
  ]) {
    assert.throws(
      () => renderLeadAlertEmail({ ...validInput, clientId: clientId as string }),
      /client id/i,
      String(clientId),
    )
  }
})

test('lead alerts reject anything other than a strict HTTPS origin', () => {
  for (const portalOrigin of [
    '',
    '//portal.example.com',
    'http://portal.example.com',
    'http://localhost:3000',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://user:pass@portal.example.com',
    'https://@portal.example.com',
    'https://portal.example.com/inbox',
    'https://portal.example.com/?view=admin',
    'https://portal.example.com?',
    'https://portal.example.com/#fragment',
    'https://portal.example.com#',
    'https://portal.example.com/..',
    'https://portal.example.com/%2e',
    'https://portal.example.com\\@evil.example',
    'https://portal.example.com\n.evil.example',
    ' https://portal.example.com',
    'https://portal.example.com\n',
    'https://portal.example.com/" onclick="alert(1)',
    null,
  ]) {
    assert.throws(
      () => renderLeadAlertEmail({ ...validInput, portalOrigin: portalOrigin as string }),
      /portal origin/i,
      String(portalOrigin),
    )
  }
})

test('HTML uses email tables and inline styles without external assets or prospect data', () => {
  const email = renderLeadAlertEmail(validInput)
  assert.match(email.html, /<table\b[^>]*role="presentation"/)
  assert.match(email.html, /style="/)
  assert.match(email.html, /Covora/)
  assert.doesNotMatch(email.html, /<(?:img|script|link|iframe|form|style|video|audio)\b/i)
  assert.doesNotMatch(email.html, /\b(?:src|srcset|background|on\w+)\s*=/i)
  assert.doesNotMatch(email.html, /@import|url\s*\(/i)
  assert.doesNotMatch(email.html + email.text, /Instantly|HeyReach|Resend|prospect@example\.com/i)
})
