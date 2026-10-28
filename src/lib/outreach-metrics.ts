/** Client-safe metrics use ratios (0–1), not percentages. Missing data stays zero. */
function count(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.min(1, Math.max(0, numerator / denominator)) : 0
}

/** uniqueReplies includes automatic replies; normalize provider totals before calling. */
export function replyRate(uniqueReplies: number, uniqueAutoReplies: number, contacted: number): number {
  return ratio(count(uniqueReplies) - count(uniqueAutoReplies), count(contacted))
}

export function positiveRate(positiveReplies: number, contacted: number): number {
  return ratio(count(positiveReplies), count(contacted))
}

export function bounceRate(bounced: number, sent: number): number {
  return ratio(count(bounced), count(sent))
}

export const CAMPAIGN_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', active: 'Active', paused: 'Paused', completed: 'Completed',
  running_subsequences: 'Following up', accounts_unhealthy: 'Needs attention',
  bounce_protection: 'Paused for delivery', suspended: 'Suspended', unknown: 'Unknown',
}

export const LEAD_STATUS_LABELS: Record<string, string> = {
  not_contacted: 'Not yet contacted', in_sequence: 'In sequence', replied: 'Replied',
  bounced: 'Bounced', unsubscribed: 'Unsubscribed', skipped: 'Skipped', paused: 'Paused',
  completed: 'Completed', unknown: 'Unknown',
}

// Documented values from the current API schema; live verification is pending the credential repair.
export function campaignStatus(status: number | null | undefined): string {
  return ({ 0: 'draft', 1: 'active', 2: 'paused', 3: 'completed', 4: 'running_subsequences',
    '-1': 'accounts_unhealthy', '-2': 'bounce_protection', '-99': 'suspended' } as Record<number, string>)[status ?? NaN] ?? 'unknown'
}

export function leadStatus(status: number | null | undefined, replyCount = 0, lastContacted?: string | null): string {
  if (status === -1) return 'bounced'
  if (status === -2) return 'unsubscribed'
  if (status === -3) return 'skipped'
  if (count(replyCount) > 0) return 'replied'
  if (status === 1) return lastContacted ? 'in_sequence' : 'not_contacted'
  return ({ 2: 'paused', 3: 'completed' } as Record<number, string>)[status ?? NaN] ?? 'unknown'
}

export const INTEREST_LABELS: Record<number, string> = {
  0: 'Out of office', 1: 'Interested', 2: 'Meeting booked', 3: 'Meeting completed',
  4: 'Won', '-1': 'Not interested', '-2': 'Wrong person', '-3': 'Lost', '-4': 'No show',
}

export function interestLabel(interest: number | null | undefined): string {
  return INTEREST_LABELS[interest ?? NaN] ?? 'Not classified'
}

/** Trim quoted history without treating ordinary prose containing “wrote” as a delimiter. */
export function trimQuotedReply(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const outlookHeaders = /^from:\s*\S/i.test(line) &&
      lines.slice(i + 1, i + 6).some((candidate) => /^(?:sent|date):\s*\S/i.test(candidate.trim())) &&
      lines.slice(i + 1, i + 8).some((candidate) => /^subject:\s*\S/i.test(candidate.trim()))
    const replyHeader = /^on\s+\S/i.test(line) && [1, 2, 3, 4].some((length) =>
      /\bwrote:\s*$/i.test(lines.slice(i, i + length).join(' ')))
    if (/^>/.test(line) || /^[-_]{2,}\s*(?:original|forwarded) message\s*[-_]*$/i.test(line) ||
      /^begin forwarded message:\s*$/i.test(line) || outlookHeaders || replyHeader) {
      end = i
      break
    }
  }
  return lines.slice(0, end).join('\n').trim()
}

/** Remove recognizable vendor footer lines; keep the lead's own unsubscribe request. */
export function stripVendorFooter(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').filter((line) =>
    !/^\s*(?:sent (?:with|via|using)|powered by)\s+instantly(?:\.ai)?\b/i.test(line) &&
    !/^\s*(?:https?:\/\/)?(?:www\.)?instantly\.ai(?:\/\S*)?\s*$/i.test(line) &&
    !/^\s*(?:unsubscribe|opt[ -]?out)\s*[:—-]?\s*https?:\/\/\S*instantly\.ai\b/i.test(line),
  ).join('\n').trim()
}
