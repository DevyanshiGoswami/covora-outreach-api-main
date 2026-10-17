import 'server-only'
import { z } from 'zod'
import { ApiError, checkDatabaseError, createOutboundHandler, json, type OutboundApiConfig } from './outbound-http'

const uuid = z.uuid()
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const querySchema = z.strictObject({
  clientId: uuid, q: z.string().trim().max(200).default(''),
  role: z.enum(['all', 'owners-executives', 'vp-director', 'manager-other']).default('all'),
  company: z.string().trim().max(500).default(''), campaign: z.union([uuid, z.literal('')]).default(''),
  list: z.union([uuid, z.literal('')]).default(''),
  email: z.enum(['all', 'available', 'verified']).default('all'),
  linkedin: z.enum(['all', 'available', 'verified']).default('all'),
  status: z.enum(['all', 'not_contacted', 'contacted', 'replied', 'completed']).default('all'),
  sort: z.enum(['priority', 'company', 'name', 'role']).default('priority'),
  page: z.string().regex(/^[1-9][0-9]{0,6}$/).transform(Number).pipe(z.number().int().max(1000000)).default(1),
})
export const leadSchema = z.object({
  id: uuid, clientId: uuid, campaignId: uuid.nullable(), campaignName: z.string().max(500).nullable(),
  listId: uuid.nullable(), listName: z.string().max(500).nullable(),
  firstName: z.string().max(500), lastName: z.string().max(500), fullName: z.string().max(500), company: z.string().max(500),
  jobTitle: z.string().max(500).nullable(), location: z.string().max(500).nullable(),
  email: z.string().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).nullable(), emailVerification: z.enum(['verified', 'unverified', 'unknown']),
  linkedinUrl: z.string().regex(/^https:\/\/www\.linkedin\.com\/in\/[a-zA-Z0-9_-]{1,200}$/).nullable(),
  linkedinVerified: z.boolean().nullable(),
  status: z.enum(['not_contacted', 'contacted', 'in_sequence', 'replied', 'completed', 'bounced', 'unsubscribed', 'skipped', 'paused', 'unknown']),
  interest: z.string().max(500).nullable(), lastActivityAt: z.iso.datetime({ offset: true }).nullable(),
  priorityRank: z.number().int().min(1).max(1000000).nullable().optional(),
  fitReason: z.string().max(2000).nullable().optional(),
  emailValidation: z.enum(['valid', 'risky', 'unknown', 'invalid']).nullable().optional(),
  contactPreference: z.enum(['email_and_linkedin', 'linkedin_first']).nullable().optional(),
  researchGaps: z.string().max(4000).nullable().optional(),
  researchedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  sourceUrls: z.array(z.string().max(1500).regex(/^https:\/\/([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}(\/[^\s?#]*)?$/)).max(20).optional(),
})
const pageSchema = z.object({
  clientId: uuid, leads: z.array(leadSchema).max(36), total: nonnegative,
  page: z.number().int().min(1).max(1000000), pageSize: z.literal(36),
  summary: z.object({ total: nonnegative, verifiedEmail: nonnegative, withLinkedIn: nonnegative, companies: nonnegative }),
  companies: z.array(z.string().max(500)).max(1001), campaigns: z.array(z.object({ id: uuid, name: z.string().max(500) })).max(501),
  lists: z.array(z.object({ id: uuid, name: z.string().max(500) })).max(501),
  filterOptionsTruncated: z.boolean(),
})
export type OutboundLeadDirectory = z.infer<typeof pageSchema>

export function createOutboundLeadHandlers(config?: OutboundApiConfig) {
  const handle = createOutboundHandler(config, {
    400: 'Invalid lead filters. Clear your filters and try again.',
    401: 'Sign in to see your leads.',
    403: 'These leads are unavailable for your account.',
    500: 'Your leads could not be loaded. Please try again.',
  })
  return { GET: handle(async (request, client) => {
    const entries = [...new URL(request.url).searchParams]
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new ApiError(400)
    const parsed = querySchema.safeParse(Object.fromEntries(entries))
    if (!parsed.success) throw new ApiError(400)
    const value = parsed.data
    const result = await client.rpc('list_outreach_leads', {
      p_client_id: value.clientId, p_q: value.q, p_role: value.role, p_company: value.company,
      ...(value.campaign ? { p_campaign: value.campaign } : {}),
      ...(value.list ? { p_list: value.list } : {}),
      p_email: value.email, p_linkedin: value.linkedin, p_status: value.status, p_sort: value.sort, p_page: value.page,
    })
    checkDatabaseError(result.error)
    const projected = pageSchema.safeParse(result.data)
    if (!projected.success) throw new ApiError(500)
    const page = projected.data
    if (page.clientId !== value.clientId || page.leads.some(lead => lead.clientId !== value.clientId
      || (value.campaign !== '' && lead.campaignId !== value.campaign)
      || (value.list !== '' && lead.listId !== value.list)
      || (lead.campaignId === null) !== (lead.campaignName === null)
      || (lead.listId === null) !== (lead.listName === null)
      || (lead.campaignId === null) === (lead.listId === null)
      || (lead.linkedinVerified === true && !lead.linkedinUrl))
      || new Set(page.leads.map(lead => lead.id)).size !== page.leads.length
      || new Set(page.campaigns.map(campaign => campaign.id)).size !== page.campaigns.length
      || new Set(page.lists.map(list => list.id)).size !== page.lists.length
      || page.total > page.summary.total || page.summary.verifiedEmail > page.summary.total
      || page.summary.withLinkedIn > page.summary.total || page.summary.companies > page.summary.total
      || page.page !== Math.min(value.page, Math.max(1, Math.ceil(page.total / 36)))
      || page.leads.length !== Math.min(36, Math.max(0, page.total - (page.page - 1) * 36))) throw new ApiError(500)
    return json(page)
  }) }
}
