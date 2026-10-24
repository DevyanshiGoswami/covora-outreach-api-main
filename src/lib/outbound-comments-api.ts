import 'server-only'
import { z } from 'zod'
import { ApiError, checkDatabaseError, createOutboundHandler, json, readJson, type OutboundApiConfig } from './outbound-http'

const uuid = z.uuid()
const status = z.enum(['open', 'in_progress', 'resolved'])
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.iso.datetime({ offset: true })
const body = z.string().max(5000).trim().min(1)
const title = z.string().max(120).trim().min(1)
// Profiles allow 200 PostgreSQL characters, including two-unit astral characters.
// Zod 4.6+ counts characters like the database's length(author_name) <= 200.
const authorName = z.string().min(1).max(200)
const offset = z.string().regex(/^(0|[1-9]\d{0,5})$/).transform(Number).refine((n) => n <= 100000).default(0)
const listQuery = z.strictObject({ clientId: uuid, status: z.enum(['all', 'open', 'in_progress', 'resolved']).default('all'), offset })
const detailQuery = z.strictObject({ clientId: uuid, offset })
const summary = z.object({
  id: uuid, clientId: uuid, title, status, version, createdAt: timestamp, updatedAt: timestamp,
  authorName, replyCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
const listResult = z.object({
  clientId: uuid, enabled: z.boolean(), permissions: z.object({ canComment: z.boolean(), canManage: z.boolean() }),
  requests: z.array(summary).max(25), hasMore: z.boolean(),
})
const detailResult = z.object({
  clientId: uuid, request: summary.extend({ body }),
  messages: z.array(z.object({ id: uuid, requestId: uuid, clientId: uuid, body, authorName, createdAt: timestamp })).max(25),
  hasMore: z.boolean(),
})
const createInput = z.strictObject({ clientId: uuid, commandId: uuid, title, body })
const replyInput = z.strictObject({ clientId: uuid, commandId: uuid, body })
const statusInput = z.strictObject({ clientId: uuid, expectedVersion: version, status })

function query<T>(request: Request, schema: z.ZodType<T>): T {
  const entries = [...new URL(request.url).searchParams]
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new ApiError(400)
  const parsed = schema.safeParse(Object.fromEntries(entries))
  if (!parsed.success) throw new ApiError(400)
  return parsed.data
}
async function input<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (new URL(request.url).search) throw new ApiError(400)
  // 5,000 Unicode characters plus JSON escaping fit without relaxing other APIs.
  const parsed = schema.safeParse(await readJson(request, 32768))
  if (!parsed.success) throw new ApiError(400)
  return parsed.data
}
function requestId(value: string): string {
  const parsed = uuid.safeParse(value)
  if (!parsed.success) throw new ApiError(400)
  return parsed.data
}
function conflict(error: { code: string } | null): Response | null {
  if (error?.code === '40001') return json({ error: 'This request changed or the saved command differs. Refresh before trying again.' }, 409)
  checkDatabaseError(error)
  return null
}

export function createOutboundCommentsHandlers(config?: OutboundApiConfig) {
  const handle = createOutboundHandler(config, {
    400: 'Invalid comments request. Check the fields and try again.',
    401: 'Sign in to continue.',
    403: 'Comments are unavailable for this workspace or your account.',
    500: 'Unable to load or save comments. Please try again.',
  })
  return {
    list: handle(async (request, client) => {
      const value = query(request, listQuery)
      const result = await client.rpc('list_outreach_comments', { p_client: value.clientId, p_status: value.status, p_offset: value.offset })
      checkDatabaseError(result.error)
      const parsed = listResult.safeParse(result.data)
      if (!parsed.success || parsed.data.clientId !== value.clientId || parsed.data.requests.some((row) => row.clientId !== value.clientId)) throw new ApiError(500)
      const data = parsed.data
      if ((!data.enabled && (data.requests.length || data.hasMore || data.permissions.canComment || data.permissions.canManage))
        || (data.permissions.canManage && !data.permissions.canComment)) throw new ApiError(500)
      return json(data)
    }),
    detail: (request: Request, id: string) => handle(async (request, client) => {
      const value = query(request, detailQuery)
      const selected = requestId(id)
      const result = await client.rpc('get_outreach_comment', { p_client: value.clientId, p_request: selected, p_offset: value.offset })
      checkDatabaseError(result.error)
      const parsed = detailResult.safeParse(result.data)
      if (!parsed.success || parsed.data.clientId !== value.clientId || parsed.data.request.clientId !== value.clientId
        || parsed.data.request.id !== selected || parsed.data.messages.some((row) => row.clientId !== value.clientId || row.requestId !== selected)) throw new ApiError(500)
      return json(parsed.data)
    })(request),
    create: handle(async (request, client) => {
      const value = await input(request, createInput)
      const result = await client.rpc('create_outreach_comment', { p_client: value.clientId, p_command: value.commandId, p_title: value.title, p_body: value.body })
      const failed = conflict(result.error)
      if (failed) return failed
      const parsed = uuid.safeParse(result.data)
      if (!parsed.success) throw new ApiError(500)
      return json({ requestId: parsed.data })
    }),
    reply: (request: Request, id: string) => handle(async (request, client) => {
      const value = await input(request, replyInput)
      const selected = requestId(id)
      const result = await client.rpc('reply_outreach_comment', { p_client: value.clientId, p_request: selected, p_command: value.commandId, p_body: value.body })
      const failed = conflict(result.error)
      if (failed) return failed
      if (result.data !== selected) throw new ApiError(500)
      return json({ requestId: selected })
    })(request),
    updateStatus: (request: Request, id: string) => handle(async (request, client) => {
      const value = await input(request, statusInput)
      const result = await client.rpc('set_outreach_comment_status', { p_client: value.clientId, p_request: requestId(id), p_version: value.expectedVersion, p_status: value.status })
      const failed = conflict(result.error)
      if (failed) return failed
      return json({ ok: true })
    })(request),
  }
}
