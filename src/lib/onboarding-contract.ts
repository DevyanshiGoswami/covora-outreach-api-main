import { z } from 'zod'

export const channelSchema = z.enum(['email', 'linkedin'])
export const portalContextSchema = z.object({
  userId: z.uuid(), isOwner: z.boolean(), workspaces: z.array(z.object({ id: z.uuid(), name: z.string(), role: z.string() })),
})
export const connectionSchema = z.object({
  id: z.uuid(), channel: channelSchema,
  state: z.enum(['starting', 'pending', 'connected', 'failed', 'expired', 'uncertain', 'needs_review']),
  canContinue: z.boolean(), updatedAt: z.string(),
})
export const peopleSchema = z.array(z.object({ id: z.uuid(), name: z.string(), email: z.string(), source: z.enum(['team', 'external']), isSelf: z.boolean(), canConnect: z.boolean(), role: z.enum(['client_admin', 'client_member', 'client_viewer', 'operator']).nullable(), access: z.enum(['active', 'suspended', 'revoked']).nullable(), connections: z.array(connectionSchema) }))
export type PortalContext = z.infer<typeof portalContextSchema>
export type Person = z.infer<typeof peopleSchema>[number]
export type Channel = z.infer<typeof channelSchema>
export type IntegrationStatus = { email: boolean; linkedin: boolean }
export type IntegrationOption = { id: string; label: string; channel: Channel; keyConfigured: boolean }
