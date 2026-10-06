import 'server-only'
import { z } from 'zod'
import { ApiError, checkDatabaseError, createOutboundHandler, json, readJson, type OutboundApiConfig } from './outbound-http'

const uuid = z.uuid()
const channel = z.enum(['email', 'linkedin'])
const method = z.enum(['google_workspace', 'microsoft', 'assisted'])
const status = z.enum(['requested', 'in_progress', 'needs_action', 'resolved'])
const note = z.string().refine((value) => [...value].length <= 1000)

const setupRequestSchema = z.object({
  id: uuid,
  client_id: uuid,
  channel,
  method,
  status,
  note,
  created_at: z.string(),
  updated_at: z.string(),
})
export type SetupRequest = z.infer<typeof setupRequestSchema>

const createSchema = z.strictObject({ clientId: uuid, channel, method })
  .refine((value) => value.channel !== 'linkedin' || value.method === 'assisted')
const updateSchema = z.strictObject({ requestId: uuid, status, note })

/** Per-request, bearer-only access; RLS/RPCs enforce workspace roles. */
export function createOutboundSetupHandlers(config?: OutboundApiConfig) {
  const handle = createOutboundHandler(config, {
    400: 'Invalid setup request.',
    401: 'Sign in to continue.',
    403: 'You do not have access to this setup request.',
    500: 'Unable to complete the setup request. Please try again.',
  })
  return {
    GET: handle(async (request, client) => {
      const query = [...new URL(request.url).searchParams]
      if (query.length !== 1 || query[0][0] !== 'clientId') throw new ApiError(400)
      const clientId = uuid.safeParse(query[0][1])
      if (!clientId.success) throw new ApiError(400)
      const workspace = await client.from('client_outreach_workspaces')
        .select('client_id').eq('client_id', clientId.data).maybeSingle()
      checkDatabaseError(workspace.error)
      if (!workspace.data) throw new ApiError(403)
      const requests = await client.from('client_outreach_setup_requests')
        .select('id,client_id,channel,method,status,note,created_at,updated_at')
        .eq('client_id', clientId.data).order('created_at', { ascending: false })
      checkDatabaseError(requests.error)
      const parsed = z.array(setupRequestSchema).safeParse(requests.data)
      if (!parsed.success) throw new ApiError(500)
      return json({ requests: parsed.data })
    }),
    POST: handle(async (request, client) => {
      const parsed = createSchema.safeParse(await readJson(request))
      if (!parsed.success) throw new ApiError(400)
      const result = await client.rpc('request_outreach_setup', {
        p_client_id: parsed.data.clientId,
        p_channel: parsed.data.channel,
        p_method: parsed.data.method,
      })
      checkDatabaseError(result.error)
      const requestId = uuid.safeParse(result.data)
      if (!requestId.success) throw new ApiError(500)
      return json({ requestId: requestId.data })
    }),
    PATCH: handle(async (request, client) => {
      const parsed = updateSchema.safeParse(await readJson(request))
      if (!parsed.success) throw new ApiError(400)
      const result = await client.rpc('update_outreach_setup_request', {
        p_request_id: parsed.data.requestId,
        p_status: parsed.data.status,
        p_note: parsed.data.note,
      })
      checkDatabaseError(result.error)
      return json({ ok: true })
    }),
  }
}
