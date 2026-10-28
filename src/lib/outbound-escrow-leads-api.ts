import 'server-only'
import { z } from 'zod'
import { ApiError, checkDatabaseError, createOutboundHandler, json, type OutboundApiConfig } from './outbound-http'
import { leadSchema } from './outbound-leads-api'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const querySchema = z.strictObject({
  clientId: z.uuid(), q: z.string().trim().max(200).default(''),
  page: z.string().regex(/^[1-9][0-9]{0,6}$/).transform(Number).pipe(z.number().int().max(1000000)).default(1),
})
const escrowRowSchema = leadSchema.extend({
  campaignId: z.null(), campaignName: z.null(), listId: z.uuid(), listName: z.string().max(500),
  reviewState: z.literal('escrow'), reviewReason: z.string().min(1).max(2000),
  reviewedAt: z.iso.datetime({ offset: true }),
})
const pageSchema = z.object({
  clientId: z.uuid(), leads: z.array(escrowRowSchema).max(36), total: count,
  page: z.number().int().min(1).max(1000000), pageSize: z.literal(36),
  summary: z.object({ escrow: count, clientVisible: count }),
})
export type OutboundEscrowDirectory = z.infer<typeof pageSchema>

/** Explicit operator projection. Uses the user's bearer, never a service key. */
export function createOutboundEscrowLeadHandlers(config?: OutboundApiConfig) {
  const handle = createOutboundHandler(config, {
    400: 'Invalid lead filters. Clear your filters and try again.',
    401: 'Sign in to review these leads.',
    403: 'Lead review is unavailable for your account.',
    500: 'The review list could not be loaded. Please try again.',
  })
  return { GET: handle(async (request, client) => {
    const entries = [...new URL(request.url).searchParams]
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new ApiError(400)
    const parsed = querySchema.safeParse(Object.fromEntries(entries))
    if (!parsed.success) throw new ApiError(400)
    const value = parsed.data
    const result = await client.rpc('list_outreach_escrow_leads', {
      p_client_id: value.clientId, p_q: value.q, p_page: value.page,
    })
    checkDatabaseError(result.error)
    const projected = pageSchema.safeParse(result.data)
    if (!projected.success) throw new ApiError(500)
    const page = projected.data
    if (page.clientId !== value.clientId || page.leads.some(lead => lead.clientId !== value.clientId
      || lead.priorityRank != null || (lead.linkedinVerified === true && !lead.linkedinUrl))
      || new Set(page.leads.map(lead => lead.id)).size !== page.leads.length
      || page.total > page.summary.escrow
      || page.page !== Math.min(value.page, Math.max(1, Math.ceil(page.total / 36)))
      || page.leads.length !== Math.min(36, Math.max(0, page.total - (page.page - 1) * 36))) throw new ApiError(500)
    return json(page)
  }) }
}
