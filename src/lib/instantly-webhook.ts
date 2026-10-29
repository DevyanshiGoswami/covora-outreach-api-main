import 'server-only'
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { createSupabaseAdminClient } from './supabase/admin'

/** Instantly reply_received webhook. The payload only identifies which recorded
 * portal campaign/lead to re-read; message text is never stored from it. Unknown
 * campaigns (other customers, campaigns made in Instantly) are acknowledged and dropped. */
type Environment = Readonly<Record<string, string | undefined>>
export type WebhookOptions = { env?: Environment; record?: (eventKey: string, campaignId: string, leadEmail: string) => Promise<string> }
const MAX_BYTES = 262_144
const payloadSchema = z.object({
  event_type: z.string().max(100),
  campaign_id: z.string().min(1).max(200).optional(),
  lead_email: z.string().trim().toLowerCase().pipe(z.email().max(254)).optional(),
  email_id: z.string().min(1).max(1000).optional(),
  timestamp: z.string().min(1).max(100).optional(),
})

function respond(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

function suppliedSecret(request: Request): string | null {
  const header = request.headers.get('x-covora-webhook-secret')
    ?? request.headers.get('authorization')?.match(/^Bearer[\t ]+([^\s,]+)[\t ]*$/i)?.[1]
  // Query fallback for providers that cannot set headers. Keep the URL out of shared logs.
  return header ?? new URL(request.url).searchParams.get('token')
}

function sameSecret(expected: string, supplied: string | null) {
  if (!supplied) return false
  const a = createHash('sha256').update(expected).digest(), b = createHash('sha256').update(supplied).digest()
  return timingSafeEqual(a, b)
}

async function recordEvent(eventKey: string, campaignId: string, leadEmail: string) {
  const result = await createSupabaseAdminClient().rpc('record_instantly_reply_event', { p_event_key: eventKey, p_provider_campaign_id: campaignId, p_lead_email: leadEmail })
  if (result.error || typeof result.data !== 'string') throw new Error('Webhook event could not be recorded')
  return result.data
}

export async function handleInstantlyWebhook(request: Request, options: WebhookOptions = {}): Promise<Response> {
  const env = options.env ?? process.env
  const secret = env.OUTREACH_INSTANTLY_WEBHOOK_SECRET?.trim()
  if (!secret || secret.length < 32) return respond({ error: 'Unavailable' }, 404)
  if (!sameSecret(secret, suppliedSecret(request))) return respond({ error: 'Unauthorized' }, 401)
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) return respond({ error: 'Invalid' }, 400)
  let raw: string
  try {
    raw = await request.text()
    if (Buffer.byteLength(raw) > MAX_BYTES) return respond({ error: 'Invalid' }, 400)
  } catch { return respond({ error: 'Invalid' }, 400) }
  let payload: z.infer<typeof payloadSchema>
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return respond({ error: 'Invalid' }, 400)
    payload = parsed.data
  } catch { return respond({ error: 'Invalid' }, 400) }
  const quiet = (result: string) => respond(env.NODE_ENV === 'production' ? { ok: true } : { ok: true, result })
  if (payload.event_type !== 'reply_received' || !payload.campaign_id || !payload.lead_email) return quiet('ignored')
  // Same provider event delivered twice maps to one key; without an id, the exact body does.
  const identity = payload.email_id ?? createHash('sha256').update(raw).digest('hex')
  const eventKey = createHash('sha256').update(`${payload.campaign_id}\u0000${payload.lead_email}\u0000${identity}`).digest('hex')
  try {
    return quiet(await (options.record ?? recordEvent)(eventKey, payload.campaign_id, payload.lead_email))
  } catch {
    // A 5xx asks the provider to redeliver; the backup sync also recovers the reply.
    return respond({ error: 'Unavailable' }, 503)
  }
}
