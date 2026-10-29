import 'server-only'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from './database.types'
import { requireRuntimeDatabase } from './runtime-config'
import { portalOutreachEnabled, startPortalOutreach, type PortalOutreachOptions } from './portal-outreach-provider'
import { ApiError, checkDatabaseError, createOutboundHandler, json, readJson, type OutboundApiConfig } from './outbound-http'

export type OutboundOutreachApiConfig = OutboundApiConfig & {
  serviceKey?: string
  env?: Readonly<Record<string, string | undefined>>
  credentials?: Readonly<Record<string, string | undefined>>
  providerFetch?: typeof fetch
  provider?: { start: typeof startPortalOutreach }
}
const uuid = z.uuid()
const timestamp = z.iso.datetime({ offset: true })
const sendSchema = z.object({
  id: uuid, clientId: uuid, status: z.enum(['queued', 'creating', 'scheduled', 'sent', 'failed', 'unknown']),
  recipientEmail: z.string(), recipientName: z.string(), senderAddress: z.string(), subject: z.string(),
  createdAt: timestamp, updatedAt: timestamp, conversationId: uuid.nullable(),
})
const optionsSchema = z.object({
  prospects: z.array(z.object({ id: uuid, name: z.string(), email: z.string(), company: z.string() })).max(500),
  senders: z.array(z.object({ connectionId: uuid, address: z.string(), label: z.string() })).max(100),
})
const clientInput = z.strictObject({ clientId: uuid })
const startInput = z.strictObject({
  clientId: uuid, sendId: uuid, leadId: uuid, connectionId: uuid,
  subject: z.string().trim().min(1).max(500).refine(value => !/[\r\n]/.test(value)),
  bodyText: z.string().trim().min(1).refine(value => [...value].length <= 4000),
})
const claimSchema = z.object({ claimToken: uuid, context: z.object({
  credentialRef: z.string().min(1).max(200), remoteWorkspaceId: z.string().min(1).max(200), senderAddress: z.string(),
  recipientEmail: z.string(), recipientFirstName: z.string(), recipientLastName: z.string(), recipientCompany: z.string(),
  subject: z.string(), bodyText: z.string(), campaignName: z.string().min(1).max(200),
}) })
type Send = z.infer<typeof sendSchema>

function parse<T>(schema: z.ZodType<T>, value: unknown, status: 400 | 500 = 500): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new ApiError(status)
  return result.data
}
function query<T>(request: Request, schema: z.ZodType<T>): T {
  const entries = [...new URL(request.url).searchParams]
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new ApiError(400)
  return parse(schema, Object.fromEntries(entries), 400)
}
function projectSend(value: unknown, clientId: string, sendId?: string): Send {
  const send = parse(sendSchema, value)
  if (send.clientId !== clientId || (sendId !== undefined && send.id !== sendId)) throw new ApiError(500)
  return send
}

function serviceClient(config: OutboundOutreachApiConfig | undefined) {
  const runtime = config ? null : requireRuntimeDatabase(true)
  const url = config?.url ?? runtime?.url
  const key = config?.serviceKey ?? runtime?.serviceKey
  if (!url || !key) throw new ApiError(500)
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    // A disconnected browser must not discard the outcome of an already attempted provider write.
    global: { fetch: async (input, init) => {
      try {
        const signals = [AbortSignal.timeout(Math.max(1, Math.min(config?.timeoutMs ?? 5000, 5000)))]
        if (init?.signal) signals.push(init.signal)
        return await (config?.fetch ?? fetch)(input, { ...init, signal: AbortSignal.any(signals), redirect: 'error', cache: 'no-store' })
      } catch { return Response.json({ message: 'Request unavailable.' }, { status: 503 }) }
    } },
  })
}

export function createOutboundOutreachHandlers(config?: OutboundOutreachApiConfig) {
  const handle = createOutboundHandler(config, {
    400: 'Invalid outreach request. Refresh before trying again.',
    401: 'Sign in to continue.',
    403: 'Outreach is unavailable for your account.',
    500: 'The outreach could not be confirmed. Refresh before trying again.',
  })
  const enabled = () => portalOutreachEnabled(config?.env)
  return {
    options: handle(async (request, client) => {
      const value = query(request, clientInput)
      const result = await client.rpc('portal_outreach_options', { p_client_id: value.clientId })
      checkDatabaseError(result.error)
      return json({ ...parse(optionsSchema, result.data), sendingEnabled: enabled() })
    }),
    GET: handle(async (request, client) => {
      const value = query(request, clientInput)
      const result = await client.rpc('list_portal_outreach', { p_client_id: value.clientId })
      checkDatabaseError(result.error)
      const sends = parse(z.array(z.unknown()).max(25), result.data).map(item => projectSend(item, value.clientId))
      return json({ outreach: sends })
    }),
    POST: handle(async (request, client) => {
      if (!enabled()) throw new ApiError(403)
      if (new URL(request.url).search) throw new ApiError(400)
      const value = parse(startInput, await readJson(request, 16_384), 400)
      const enqueued = await client.rpc('enqueue_portal_outreach', {
        p_client_id: value.clientId, p_send_id: value.sendId, p_lead_id: value.leadId,
        p_connection_id: value.connectionId, p_subject: value.subject, p_body: value.bodyText,
      })
      checkDatabaseError(enqueued.error)
      if (projectSend(enqueued.data, value.clientId, value.sendId).status === 'queued') {
        const admin = serviceClient(config)
        const claimed = await admin.rpc('claim_portal_outreach', { p_send_id: value.sendId })
        checkDatabaseError(claimed.error)
        if (claimed.data !== null) {
          const claim = parse(claimSchema, claimed.data)
          const options: PortalOutreachOptions = { env: config?.env, credentials: config?.credentials, fetch: config?.providerFetch }
          let outcome: Awaited<ReturnType<typeof startPortalOutreach>> = { status: 'unknown', providerCampaignId: null, providerLeadId: null, errorCode: 'dispatch_unknown' }
          try { outcome = await (config?.provider ?? { start: startPortalOutreach }).start(claim.context, options) }
          catch { /* Once provider writes may have started, the outcome stays unknown and is never retried. */ }
          const finished = await admin.rpc('finish_portal_outreach', {
            p_send_id: value.sendId, p_claim_token: claim.claimToken, p_status: outcome.status,
            ...(outcome.providerCampaignId ? { p_provider_campaign_id: outcome.providerCampaignId } : {}),
            ...(outcome.providerLeadId ? { p_provider_lead_id: outcome.providerLeadId } : {}),
            ...(outcome.errorCode ? { p_error_code: outcome.errorCode } : {}),
          })
          checkDatabaseError(finished.error)
          if (typeof finished.data !== 'boolean') throw new ApiError(500)
        }
      }
      // Reverify the bearer and read durable state; a provider response is never the receipt.
      return handle(async (_request, freshClient) => {
        const result = await freshClient.rpc('read_portal_outreach', { p_client_id: value.clientId, p_send_id: value.sendId })
        checkDatabaseError(result.error)
        return json({ outreach: projectSend(result.data, value.clientId, value.sendId) })
      })(request)
    }),
  }
}
