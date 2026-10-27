import 'server-only'
import { z } from 'zod'
import { ApiError, checkDatabaseError, createOutboundHandler, json, type OutboundApiConfig } from './outbound-http'

export const campaignPlanSchema = z.object({
  id: z.uuid(), name: z.string().min(1).max(500),
  audience: z.enum(['hiring_partners', 'athletes']), channel: z.enum(['email', 'linkedin']),
  status: z.literal('draft'), leadCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
}).refine(plan => plan.audience !== 'athletes' || plan.channel === 'linkedin')
export type OutboundCampaignPlan = z.infer<typeof campaignPlanSchema>
const querySchema = z.strictObject({ clientId: z.uuid() })
const responseSchema = z.object({ campaigns: z.array(campaignPlanSchema).max(1000) })

/** Native review plans only. There is deliberately no mutation or launch handler. */
export function createOutboundCampaignPlanHandlers(config?: OutboundApiConfig) {
  const handle = createOutboundHandler(config, {
    400: 'Invalid campaign filters.', 401: 'Sign in to see your campaigns.',
    403: 'These campaigns are unavailable for your account.',
    500: 'Your campaigns could not be loaded. Please try again.',
  })
  return { GET: handle(async (request, client) => {
    const entries = [...new URL(request.url).searchParams]
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new ApiError(400)
    const query = querySchema.safeParse(Object.fromEntries(entries))
    if (!query.success) throw new ApiError(400)
    const result = await client.rpc('list_outreach_campaign_plans', { p_client_id: query.data.clientId })
    checkDatabaseError(result.error)
    const parsed = responseSchema.safeParse(result.data)
    if (!parsed.success || new Set(parsed.data.campaigns.map(plan => plan.id)).size !== parsed.data.campaigns.length) throw new ApiError(500)
    return json(parsed.data)
  }) }
}
