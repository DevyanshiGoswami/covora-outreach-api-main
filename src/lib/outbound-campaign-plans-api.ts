import 'server-only'
import { z } from 'zod'
import { ApiError, checkDatabaseError, createOutboundHandler, json, type OutboundApiConfig } from './outbound-http'

export const campaignPlanSchema = z.object({
  id: z.uuid(), name: z.string().min(1).max(500),
  audience: z.enum(['hiring_partners', 'athletes']), channel: z.enum(['email', 'linkedin']),
  status: z.literal('draft'), leadCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
}).refine(plan => plan.audience !== 'athletes' || plan.channel === 'linkedin')
const displayText = (maximum: number) => z.string().min(1).max(maximum)
  .refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value))
export const campaignSequenceStepSchema = z.object({
  position: z.number().int().min(1).max(20),
  dayOffset: z.number().int().min(0).max(365).nullable(),
  subject: displayText(500).nullable(),
  body: z.string().min(1).max(10000).refine(value => value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)),
  sameThread: z.boolean(), stage: z.enum(['email', 'after_connection']),
})
export const campaignSequenceVariantSchema = z.object({
  key: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
  label: displayText(200), audienceLabel: displayText(500),
  senderLabel: displayText(200).nullable(), reviewNote: displayText(2000).nullable(),
  steps: z.array(campaignSequenceStepSchema).min(1).max(20),
}).refine(variant => variant.steps.every((step, index) => step.position === index + 1))
export const campaignPlanWithSequencesSchema = campaignPlanSchema.safeExtend({
  sequenceVariants: z.array(campaignSequenceVariantSchema).max(20),
}).refine(plan => new Set(plan.sequenceVariants.map(variant => variant.key)).size === plan.sequenceVariants.length)
  .refine(plan => plan.sequenceVariants.every(variant => variant.steps.every((step, index) => {
    if (plan.channel === 'linkedin') return step.stage === 'after_connection' && step.subject === null && !step.sameThread
    return step.stage === 'email' && step.dayOffset !== null
      && (index !== 0 || step.dayOffset === 0 && !step.sameThread)
      && (index === 0 || step.dayOffset >= variant.steps[index - 1].dayOffset!)
      && (step.sameThread ? step.subject === null : step.subject !== null)
  })))
export type OutboundCampaignPlan = z.infer<typeof campaignPlanWithSequencesSchema>
const querySchema = z.strictObject({ clientId: z.uuid() })
const responseSchema = z.object({ campaigns: z.array(campaignPlanWithSequencesSchema).max(1000) })

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
