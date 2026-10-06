import 'server-only'
import { z } from 'zod'
import { renderLeadAlertEmail } from './outreach-lead-alert-email'
import { leadAlertDispatchSchema, type LeadAlertTransport } from './outreach-lead-alert-worker'

type Environment = Readonly<Record<string, string | undefined>>
type Options = { environment?: Environment; fetch?: typeof fetch; now?: () => number }
const TIMEOUT_MS = 8000
const MAX_RESPONSE_BYTES = 8192
const CONTROL = /[\u0000-\u001f\u007f]/
const rejectionStatuses = new Set([400, 401, 403, 404, 405, 422, 429])

function configuration(env: Environment) {
  const apiKey = env.RESEND_API_KEY
  const from = env.NOTIFY_FROM
  const portalOrigin = env.OUTREACH_PORTAL_ORIGIN
  if (env.ENABLE_OUTREACH_LEAD_ALERT_EMAILS !== 'true' || !apiKey || /\s/.test(apiKey) || CONTROL.test(apiKey)
    || !from || from.length > 254 || CONTROL.test(from) || !portalOrigin) return null
  // Accept one mailbox, optionally with a simple display name. Never inherit
  // the legacy onboarding@resend.dev fallback or permit recipient lists.
  const named = /^[^<>,";]+ <([^<>]+)>$/.exec(from)
  const address = named ? named[1] : from
  if (!z.email().safeParse(address).success || address.toLowerCase().endsWith('@resend.dev')) return null
  try {
    // Keep link validation in the renderer, which owns the public email format.
    renderLeadAlertEmail({ leadCount: 1, clientId: '00000000-0000-4000-8000-000000000000', portalOrigin })
  } catch { return null }
  return { apiKey, from, portalOrigin }
}

async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing response')
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) { cancel(); throw new Error('Oversized response') }
      text += decoder.decode(chunk.value, { stream: true })
    }
    signal.throwIfAborted()
    return JSON.parse(text + decoder.decode())
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

/**
 * Resend HTTP contract verified against its official send/idempotency docs.
 * `sent` means accepted by Resend, not delivered to the recipient's inbox.
 * A 24h provider key supplements our permanent receipts; it never licenses a
 * retry after an uncertain result. No raw response or exception is logged.
 */
export function createLeadAlertTransport(options: Options = {}): LeadAlertTransport {
  const env = options.environment ?? process.env
  const config = configuration(env)
  const now = options.now ?? Date.now
  return {
    configured: config !== null,
    async send(delivery) {
      if (!config || env.ENABLE_OUTREACH_LEAD_ALERT_EMAILS !== 'true') {
        return { status: 'failed', errorCode: 'delivery_unconfigured' }
      }
      if (!leadAlertDispatchSchema.safeParse(delivery).success || Date.parse(delivery.expiresAt) <= now()) {
        return { status: 'failed', errorCode: 'invalid_dispatch' }
      }
      const email = renderLeadAlertEmail({ leadCount: delivery.leadCount, clientId: delivery.clientId, portalOrigin: config.portalOrigin })
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      // Bound the entire attempt, including body consumption. Abort alone
      // cannot settle a broken transport that ignores its signal.
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Delivery timeout')) }, TIMEOUT_MS)
      })
      const request = async (): Promise<Awaited<ReturnType<LeadAlertTransport['send']>>> => {
        const response = await (options.fetch ?? fetch)('https://api.resend.com/emails', {
          method: 'POST', redirect: 'error', cache: 'no-store', signal: controller.signal,
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json',
            'Idempotency-Key': `covora-lead-alert/${delivery.id}` },
          body: JSON.stringify({ from: config.from, to: [delivery.recipientEmail], ...email }),
        })
        const parsed = await responseJson(response, controller.signal)
        const object = z.record(z.string(), z.unknown()).safeParse(parsed)
        if (!object.success) return { status: 'unknown', errorCode: 'transport_unknown' }
        const body = object.data
        // Resend's schema specifies an opaque string ID, not a UUID.
        if (response.status === 200 && typeof body.id === 'string' && body.id.length > 0 && body.id.length <= 256
          && body.id.trim() === body.id && !CONTROL.test(body.id) && !('error' in body) && !('name' in body)) {
          return { status: 'sent' }
        }
        if (rejectionStatuses.has(response.status) && typeof body.name === 'string' && body.name.length > 0
          && typeof body.message === 'string' && !('id' in body)) {
          return { status: 'failed', errorCode: response.status === 429 ? 'rate_limited' : 'delivery_rejected' }
        }
        return { status: 'unknown', errorCode: 'transport_unknown' }
      }
      try { return await Promise.race([request(), deadline]) }
      catch { return { status: 'unknown', errorCode: 'transport_unknown' } }
      finally { clearTimeout(timer) }
    },
  }
}
