import { createHash } from 'node:crypto'

import { interestLabel, leadStatus, stripVendorFooter, trimQuotedReply } from '@/lib/outreach-metrics'
import type { InstantlyEmail, InstantlyLeadPageItem } from '@/lib/instantly'

/** Only explicitly selected provider fields may enter client-readable JSON. */
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

export function neutralText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return stripVendorFooter(value)
    .replace(/https?:\/\/[^\s<>]*instantly[^\s<>]*/gi, '')
    .replace(/instantly(?:\.ai)?/gi, 'sending engine')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[reference]')
}

export const safeOutreachText = neutralText

/** Sequence bodies are HTML even on text-only campaigns. Never persist markup. */
export function sequencePlainText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\s*br\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, code: string) => {
      const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10)
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''
    })
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_, entity: string) =>
      ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity.toLowerCase()] ?? '')
  // Entity decoding may reveal another layer of markup. Strip that too;
  // sequence copy is a text preview, never an HTML round-trip.
  return neutralText(text.replace(/<[^>]*>/g, '')).trim()
}

export function replyPlainText(body: unknown): string {
  const content = record(body)
  // Some sent messages and replies have only HTML. Keep readable text without
  // rendering markup or loading its links, images or other remote assets.
  const text = typeof content.text === 'string' && content.text.trim()
    ? content.text : sequencePlainText(content.html)
  return neutralText(trimQuotedReply(text))
}

export function neutralThreadKey(campaignId: string, providerThreadId: string): string {
  const hash = createHash('sha256').update(`${campaignId}\u0000${providerThreadId}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export function syncDue(timestamp: string | null, cadenceMs: number, now: number): boolean {
  return timestamp === null || !Number.isFinite(Date.parse(timestamp)) || Date.parse(timestamp) + cadenceMs <= now
}

export function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6))
}

/** Checkpoints move only after all pages in the fixed scan have been written. */
export function replyCheckpoint(input: {
  cursor: string | null
  watermark: string | null
  scanStartedAt: string
  nextCursor?: string | null
  itemCount: number
}) {
  if (input.itemCount > 0 && input.nextCursor && input.nextCursor === input.cursor) {
    throw new Error('Sending engine returned a repeated pagination cursor')
  }
  const next = input.itemCount > 0 ? input.nextCursor ?? null : null
  return next
    ? { reply_cursor: next, reply_watermark: input.watermark, reply_scan_started_at: input.scanStartedAt }
    : { reply_cursor: null, reply_watermark: input.scanStartedAt, reply_scan_started_at: null }
}

export function normalizedTotals(value: unknown) {
  const data = record(value)
  const automatic = count(data.reply_count_automatic_unique)
  return {
    leads: count(data.leads_count), contacted: count(data.contacted_count), sent: count(data.emails_sent_count),
    unique_opened: count(data.open_count_unique), unique_replies: count(data.reply_count_unique) + automatic,
    unique_auto_replies: automatic, bounced: count(data.bounced_count), unsubscribed: count(data.unsubscribed_count),
    completed: count(data.completed_count), opportunities: count(data.total_opportunities),
    unique_clicks: count(data.link_click_count_unique),
  }
}

export function normalizedStats(value: unknown) {
  const data = record(value)
  const automatic = count(data.unique_replies_automatic)
  return {
    sent: count(data.sent), contacted: count(data.contacted), unique_opened: count(data.unique_opened),
    // ⚠️ VERIFY: unlike totals, the published daily/step schema does not say
    // whether automatic replies are included. Preserve the raw count; do not
    // infer a daily human-reply rate until an authenticated sample settles it.
    unique_replies: count(data.unique_replies), unique_auto_replies: automatic,
    unique_clicks: count(data.unique_clicks), opportunities: count(data.opportunities),
  }
}

export function normalizedSchedule(value: unknown) {
  const data = record(value)
  const windows = (Array.isArray(data.schedules) ? data.schedules : []).map((raw) => {
    const window = record(raw)
    const timing = record(window.timing)
    return {
      timezone: neutralText(window.timezone), from: neutralText(timing.from), to: neutralText(timing.to),
      days: Object.entries(record(window.days)).filter(([day, enabled]) => /^[0-6]$/.test(day) && enabled === true).map(([day]) => Number(day)),
    }
  })
  return {
    windows,
    ...(validTimestamp(data.start_date) ? { start_date: validTimestamp(data.start_date)! } : {}),
    ...(validTimestamp(data.end_date) ? { end_date: validTimestamp(data.end_date)! } : {}),
  }
}

type Assignment = { id: string; client_id: string; provider_campaign_id: string }

function validTimestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
}

/** Missing or mismatched ownership is never inferred from a search response. */
export function messageForAssignment(assignment: Assignment | null, email: InstantlyEmail) {
  if (!assignment || email.campaign_id !== assignment.provider_campaign_id) return null
  if (typeof email.id !== 'string' || !email.id || ![1, 2, 3].includes(email.ue_type ?? 0)) return null
  const sentAt = validTimestamp(email.timestamp_email)
  if (!sentAt || typeof email.to_address_email_list !== 'string') return null
  const thread = typeof email.thread_id === 'string' && email.thread_id ? email.thread_id : email.id
  return {
    campaign_id: assignment.id, client_id: assignment.client_id,
    provider_email_id: email.id, provider_thread_id: email.thread_id ?? null,
    provider_account: typeof email.eaccount === 'string' ? email.eaccount : null,
    thread_key: neutralThreadKey(assignment.id, thread),
    direction: email.ue_type === 2 ? 'received' as const : 'sent' as const,
    lead_email: typeof email.lead === 'string' ? neutralText(email.lead).toLowerCase() : null,
    from_email: neutralText(email.from_address_email), to_email: neutralText(email.to_address_email_list),
    subject: neutralText(email.subject), body_text: replyPlainText(email.body), sent_at: sentAt,
    interest: interestLabel(typeof email.i_status === 'number' ? email.i_status : null),
    is_auto_reply: email.is_auto_reply === 1,
    // client_read_at deliberately omitted: replay must never undo a read.
  }
}

export function leadForAssignment(assignment: Assignment | null, lead: InstantlyLeadPageItem) {
  if (!assignment || (lead.campaign !== undefined && lead.campaign !== assignment.provider_campaign_id)) return null
  if (typeof lead.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) return null
  const dates = [lead.timestamp_last_contact, lead.timestamp_last_reply, lead.timestamp_last_touch,
    lead.last_step_timestamp_executed].map(validTimestamp).filter((value): value is string => value !== null).sort()
  return {
    campaign_id: assignment.id, client_id: assignment.client_id,
    provider_lead_id: typeof lead.id === 'string' ? lead.id : null,
    email: neutralText(lead.email).toLowerCase(), first_name: neutralText(lead.first_name),
    last_name: neutralText(lead.last_name), company: neutralText(lead.company_name),
    status: leadStatus(typeof lead.status === 'number' ? lead.status : null, count(lead.email_reply_count), lead.timestamp_last_contact),
    // The API's last_step_id is a UUID; it does not expose an authoritative
    // mapping to a numbered sequence step. Do not invent a last sent step.
    last_step: null,
    reply_count: count(lead.email_reply_count), interest: interestLabel(typeof lead.lt_interest_status === 'number' ? lead.lt_interest_status : null),
    last_activity_at: dates.at(-1) ?? null,
  }
}
