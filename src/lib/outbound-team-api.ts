import 'server-only'
import { z } from 'zod'
import { ApiError, checkDatabaseError, createOutboundHandler, json, readJson, type OutboundApiConfig } from './outbound-http'

const uuid = z.uuid()
const role = z.enum(['client_admin', 'client_member', 'client_viewer', 'operator'])
const state = z.enum(['active', 'suspended', 'revoked'])
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const token = z.string().regex(/^[a-f0-9]{64}$/i)
const email = z.string().trim().toLowerCase().pipe(z.email().max(254))
const memberSchema = z.object({ client_id: uuid, user_id: uuid, email: z.string().nullable(), role, state, version })
const invitationSchema = z.object({
  id: uuid, client_id: uuid, email: z.string(), role,
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']), expires_at: z.string(), created_at: z.string(),
})
export type TeamMember = z.infer<typeof memberSchema>
export type Invitation = z.infer<typeof invitationSchema>

const createSchema = z.strictObject({ clientId: uuid, email, role })
const revokeSchema = z.strictObject({ invitationId: uuid })
const changeSchema = z.strictObject({ clientId: uuid, userId: uuid, role, state, expectedVersion: version })
const tokenSchema = z.strictObject({ token })
const createdSchema = z.tuple([z.object({ invitation_id: uuid, token, expires_at: z.string() })])
const inspectedSchema = z.tuple([z.object({
  invitation_id: uuid, client_id: uuid, client_name: z.string(), role,
  expires_at: z.string(), status: z.enum(['pending', 'accepted']),
})])
const PAGE_SIZE = 500

async function readPages<T extends { client_id: string }>(
  clientId: string,
  schema: z.ZodType<T>,
  page: (offset: number) => PromiseLike<{ data: unknown; error: { code: string } | null }>,
): Promise<T[]> {
  const rows: T[] = []
  // Every page shares the request's transport deadline; never return a truncated success.
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const result = await page(offset)
    checkDatabaseError(result.error)
    const parsed = z.array(schema).safeParse(result.data)
    if (!parsed.success || parsed.data.some((row) => row.client_id !== clientId)) throw new ApiError(500)
    rows.push(...parsed.data)
    if (parsed.data.length < PAGE_SIZE) return rows
  }
}

async function input<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  // Tokens belong in request bodies, never query strings or dynamically named routes.
  if (new URL(request.url).search) throw new ApiError(400)
  const parsed = schema.safeParse(await readJson(request))
  if (!parsed.success) throw new ApiError(400)
  return parsed.data
}

export function createOutboundTeamHandlers(config?: OutboundApiConfig) {
  const handle = createOutboundHandler(config, {
    400: 'Invalid team request. Refresh and try again.',
    401: 'Sign in to continue.',
    403: 'This team request is unavailable for your account.',
    500: 'Unable to complete the team request. Please try again.',
  })
  return {
    listTeam: handle(async (request, client) => {
      const query = [...new URL(request.url).searchParams]
      if (query.length !== 1 || query[0][0] !== 'clientId') throw new ApiError(400)
      const clientId = uuid.safeParse(query[0][1])
      if (!clientId.success) throw new ApiError(400)
      const workspace = await client.from('client_outreach_workspaces')
        .select('client_id,role').eq('client_id', clientId.data).maybeSingle()
      checkDatabaseError(workspace.error)
      if (!workspace.data || !['client_admin', 'agency_owner'].includes(workspace.data.role ?? '')) throw new ApiError(403)
      const [members, invitations] = await Promise.all([
        readPages(clientId.data, memberSchema, (offset) => client.from('client_outreach_team')
          .select('client_id,user_id,email,role,state,version').eq('client_id', clientId.data)
          .order('email').order('user_id').range(offset, offset + PAGE_SIZE - 1)),
        readPages(clientId.data, invitationSchema, (offset) => client.from('client_outreach_invitations')
          .select('id,client_id,email,role,status,expires_at,created_at').eq('client_id', clientId.data)
          .order('created_at', { ascending: false }).order('id').range(offset, offset + PAGE_SIZE - 1)),
      ])
      return json({ members, invitations })
    }),
    createInvitation: handle(async (request, client) => {
      const value = await input(request, createSchema)
      const result = await client.rpc('create_outreach_invitation', {
        p_client_id: value.clientId, p_email: value.email, p_role: value.role,
      })
      checkDatabaseError(result.error)
      const parsed = createdSchema.safeParse(result.data)
      if (!parsed.success) throw new ApiError(500)
      const created = parsed.data[0]
      return json({ invitationId: created.invitation_id, token: created.token, expiresAt: created.expires_at })
    }),
    revokeInvitation: handle(async (request, client) => {
      const value = await input(request, revokeSchema)
      const result = await client.rpc('revoke_outreach_invitation', { p_invitation_id: value.invitationId })
      checkDatabaseError(result.error)
      return json({ ok: true })
    }),
    changeMembership: handle(async (request, client) => {
      const value = await input(request, changeSchema)
      const result = await client.rpc('change_outreach_membership', {
        p_client_id: value.clientId, p_user_id: value.userId, p_role: value.role,
        p_state: value.state, p_expected_version: value.expectedVersion,
      })
      checkDatabaseError(result.error)
      return json({ ok: true })
    }),
    inspectInvitation: handle(async (request, client) => {
      const value = await input(request, tokenSchema)
      const result = await client.rpc('inspect_outreach_invitation', { p_token: value.token })
      checkDatabaseError(result.error)
      const parsed = inspectedSchema.safeParse(result.data)
      if (!parsed.success) throw new ApiError(500)
      const invitation = parsed.data[0]
      return json({ invitation: {
        id: invitation.invitation_id, clientId: invitation.client_id, clientName: invitation.client_name,
        role: invitation.role, expiresAt: invitation.expires_at, status: invitation.status,
      } })
    }),
    acceptInvitation: handle(async (request, client) => {
      const value = await input(request, tokenSchema)
      const result = await client.rpc('accept_outreach_invitation', { p_token: value.token })
      checkDatabaseError(result.error)
      const clientId = uuid.safeParse(result.data)
      if (!clientId.success) throw new ApiError(500)
      return json({ clientId: clientId.data })
    }),
  }
}
