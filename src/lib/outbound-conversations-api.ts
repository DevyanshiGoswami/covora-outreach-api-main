import 'server-only'
import { requireRuntimeDatabase, repliesEnabled } from './runtime-config'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from './database.types'
import { prepareOutreachReply, sendOutreachReply } from './outreach-reply-provider'
import { ApiError, checkDatabaseError, createOutboundHandler, json, readJson, type OutboundApiConfig } from './outbound-http'

export type OutboundConversationApiConfig = OutboundApiConfig & {
  serviceKey?: string
  repliesEnabled?: boolean
  credentials?: Readonly<Record<string, string | undefined>>
  providerFetch?: typeof fetch
  providerTimeoutMs?: number
  provider?: { prepare: typeof prepareOutreachReply; send: typeof sendOutreachReply }
}
const uuid = z.uuid()
const timestamp = z.iso.datetime({ offset: true })
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const channel = z.enum(['email', 'linkedin'])
const channelFilter = z.enum(['all', 'email', 'linkedin'])
const bodyText = z.string().trim().min(1).refine((value) => [...value].length <= 4000)
const ownerSchema = z.object({ kind: z.enum(['covora', 'user']), userId: uuid.nullable(), name: z.string() })
  .refine((owner) => owner.kind === 'covora' ? owner.userId === null : owner.userId !== null)
const summarySchema = z.object({
  id: uuid, clientId: uuid, channel, campaignId: uuid.nullable(), campaignName: z.string(),
  subject: z.string(), contactName: z.string(), contactAddress: z.string(), senderLabel: z.string(),
  owner: ownerSchema, ownedByMe: z.boolean(), version, latestMessageId: uuid.nullable(), latestAt: timestamp,
  preview: z.string(), unread: z.boolean(), status: z.enum(['needs_reply', 'waiting', 'done']), interest: z.string().nullable().default(null),
  canReply: z.boolean(), canTakeover: z.boolean(), replyUnavailableReason: z.string().nullable(),
})
const messageSchema = z.object({ id: uuid, direction: z.enum(['sent', 'received']), bodyText: z.string(), sentAt: timestamp, senderLabel: z.string() })
const commandSchema = z.object({
  id: uuid, conversationId: uuid, bodyText: z.string(), status: z.enum(['pending', 'sending', 'sent', 'failed', 'unknown']),
  createdAt: timestamp, updatedAt: timestamp, actorName: z.string(),
})
const detailSchema = summarySchema.extend({ messages: z.array(messageSchema), commands: z.array(commandSchema), messagesTruncated: z.boolean() })
const replyInput = z.strictObject({ clientId: uuid, commandId: uuid, expectedVersion: version, latestMessageId: uuid, bodyText, takeover: z.boolean() })
const ownerInput = z.strictObject({ clientId: uuid, expectedVersion: version, owner: z.enum(['me', 'covora']) })
const clientInput = z.strictObject({ clientId: uuid })
const listQuery = clientInput.extend({ channel: channelFilter.default('all'), cursor: z.string().min(1).max(1024).optional() })
const cursorSchema = z.strictObject({ v: z.literal(1), clientId: uuid, channel: channelFilter, beforeAt: timestamp, beforeId: uuid })
const privateId = z.string().min(1).max(2000)
const claimSchema = z.object({ claimToken: uuid, context: z.object({
  channel, credentialRef: privateId, remoteWorkspaceId: privateId, remoteSenderId: privateId, senderAddress: z.string(),
  remoteConversationId: privateId, remoteReplyToId: privateId.nullable(), remoteLatestMessageId: privateId.nullable(),
  remoteCampaignId: privateId.nullable(), contactAddress: z.string(), latestMessageFingerprint: privateId.nullable(),
  subject: z.string(), bodyText,
}) })
const outcomeSchema = z.object({ status: z.enum(['sent', 'failed', 'unknown']), remoteMessageId: privateId.nullable() })
const PAGE_SIZE = 50

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
async function input<T>(request: Request, schema: z.ZodType<T>, id: string): Promise<T> {
  parse(uuid, id, 400)
  if (new URL(request.url).search) throw new ApiError(400)
  return parse(schema, await readJson(request), 400)
}
function cursor(value: string | undefined, clientId: string, selectedChannel: string) {
  if (value === undefined) return undefined
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error()
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) throw new Error()
    const result = cursorSchema.parse(JSON.parse(decoded.toString('utf8')))
    if (result.clientId !== clientId || result.channel !== selectedChannel) throw new Error()
    return result
  } catch { throw new ApiError(400) }
}
function projectDetail(value: unknown, clientId: string, conversationId: string) {
  const detail = parse(detailSchema, value)
  if (detail.clientId !== clientId || detail.id !== conversationId
    || detail.commands.some((command) => command.conversationId !== conversationId)
    || new Set(detail.messages.map((message) => message.id)).size !== detail.messages.length
    || new Set(detail.commands.map((command) => command.id)).size !== detail.commands.length) throw new ApiError(500)
  return detail
}
async function readDetail(client: SupabaseClient<Database>, clientId: string, conversationId: string) {
  const result = await client.rpc('read_outreach_conversation', { p_client_id: clientId, p_conversation_id: conversationId, p_limit: 100 })
  checkDatabaseError(result.error)
  return projectDetail(result.data, clientId, conversationId)
}

/** Private RPCs are reachable only after a user-scoped command authorizes the target. */
function serviceClient(request: Request, config: OutboundConversationApiConfig | undefined, finishing = false) {
  const runtime = config ? null : requireRuntimeDatabase(true)
  const url = config?.url ?? runtime?.url
  const key = config?.serviceKey ?? runtime?.serviceKey
  if (!url || !key) throw new ApiError(500)
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      try {
        const signals = [AbortSignal.timeout(Math.max(1, Math.min(config?.timeoutMs ?? 5000, 5000)))]
        // A disconnected browser must not discard the outcome of an already attempted send.
        if (!finishing) signals.push(request.signal)
        if (init?.signal) signals.push(init.signal)
        if (input instanceof Request) signals.push(input.signal)
        const signal = AbortSignal.any(signals)
        signal.throwIfAborted()
        return await (config?.fetch ?? fetch)(input, { ...init, signal, redirect: 'error', cache: 'no-store' })
      } catch { return Response.json({ message: 'Request unavailable.' }, { status: 503 }) }
    } },
  })
}

function projectCommand(value: unknown, conversationId: string, commandId: string, body: string) {
  const command = parse(commandSchema, value)
  if (command.id !== commandId || command.conversationId !== conversationId || command.bodyText !== body) throw new ApiError(500)
  return command
}

export function createOutboundConversationHandlers(config?: OutboundConversationApiConfig) {
  function sendingState<T extends z.infer<typeof summarySchema>>(value: T): T {
    return repliesEnabled(config?.repliesEnabled) ? value
      : { ...value, canReply: false, replyUnavailableReason: 'Sending is currently disabled.' }
  }
  const handle = createOutboundHandler(config, {
    400: 'Invalid conversation request. Refresh before trying again.',
    401: 'Sign in to continue.',
    403: 'This conversation is unavailable for your account.',
    500: 'The request could not be confirmed. Refresh the conversation before trying again.',
  })
  return {
    GET: handle(async (request, client) => {
      const value = query(request, listQuery)
      const before = cursor(value.cursor, value.clientId, value.channel)
      const result = await client.rpc('list_outreach_conversations', {
        p_client_id: value.clientId, p_channel: value.channel, p_limit: PAGE_SIZE + 1,
        ...(before ? { p_before_at: before.beforeAt, p_before_id: before.beforeId } : {}),
      })
      checkDatabaseError(result.error)
      const rows = parse(z.array(summarySchema).max(PAGE_SIZE + 1), result.data)
      if (rows.some((row) => row.clientId !== value.clientId || (value.channel !== 'all' && row.channel !== value.channel))
        || new Set(rows.map((row) => row.id)).size !== rows.length) throw new ApiError(500)
      const conversations = rows.slice(0, PAGE_SIZE).map(sendingState)
      const last = conversations.at(-1)
      const nextCursor = rows.length > PAGE_SIZE && last ? Buffer.from(JSON.stringify({ v: 1, clientId: value.clientId, channel: value.channel, beforeAt: last.latestAt, beforeId: last.id })).toString('base64url') : null
      return json({ conversations, nextCursor })
    }),
    detail: (request: Request, id: string) => handle(async (request, client) => {
      parse(uuid, id, 400)
      const value = query(request, clientInput)
      return json({ conversation: sendingState(await readDetail(client, value.clientId, id)) })
    })(request),
    read: (request: Request, id: string) => handle(async (request, client) => {
      const value = await input(request, clientInput, id)
      const result = await client.rpc('mark_outreach_conversation_read', { p_client_id: value.clientId, p_conversation_id: id })
      checkDatabaseError(result.error)
      return json({ ok: true })
    })(request),
    owner: (request: Request, id: string) => handle(async (request, client) => {
      const value = await input(request, ownerInput, id)
      const result = await client.rpc('change_outreach_conversation_owner', { p_client_id: value.clientId, p_conversation_id: id, p_expected_version: value.expectedVersion, p_owner: value.owner })
      checkDatabaseError(result.error)
      return json({ conversation: sendingState(projectDetail(result.data, value.clientId, id)) })
    })(request),
    reply: (request: Request, id: string) => handle(async (request, client) => {
      if (!repliesEnabled(config?.repliesEnabled)) throw new ApiError(403)
      const value = await input(request, replyInput, id)
      const enqueued = await client.rpc('enqueue_outreach_reply', {
        p_client_id: value.clientId, p_conversation_id: id, p_command_id: value.commandId,
        p_expected_version: value.expectedVersion, p_latest_message_id: value.latestMessageId,
        p_body: value.bodyText, p_takeover: value.takeover,
      })
      checkDatabaseError(enqueued.error)
      const command = projectCommand(enqueued.data, id, value.commandId, value.bodyText)
      if (command.status === 'pending') {
        const admin = serviceClient(request, config)
        const claimed = await admin.rpc('claim_outreach_reply', { p_command_id: value.commandId })
        checkDatabaseError(claimed.error)
        if (claimed.data !== null) {
          const claim = parse(claimSchema, claimed.data)
          if (claim.context.bodyText !== value.bodyText) throw new ApiError(500)
          const provider = config?.provider ?? { prepare: prepareOutreachReply, send: sendOutreachReply }
          const options = { repliesEnabled: config?.repliesEnabled, credentials: config?.credentials, fetch: config?.providerFetch, timeoutMs: config?.providerTimeoutMs, signal: request.signal }
          const finish = async (status: 'sent' | 'failed' | 'unknown', errorCode?: string, remoteMessageId?: string | null) => {
            const result = await serviceClient(request, config, true).rpc('finish_outreach_reply', {
              p_command_id: value.commandId, p_claim_token: claim.claimToken, p_status: status,
              ...(errorCode ? { p_error_code: errorCode } : {}),
              ...(remoteMessageId ? { p_remote_message_id: remoteMessageId } : {}),
            })
            checkDatabaseError(result.error)
            if (typeof result.data !== 'boolean') throw new ApiError(500)
          }
          let prepared: Awaited<ReturnType<typeof prepareOutreachReply>>
          try { prepared = await provider.prepare(claim.context, options) }
          catch { prepared = { ok: false, reason: 'unavailable' } }
          if (!prepared.ok) {
            const reason = ['unavailable', 'changed', 'identity_mismatch'].includes(prepared.reason) ? prepared.reason : 'unavailable'
            await finish('failed', `prepare_${reason}`)
          } else {
            // The SQL gate rechecks actor, ownership, latest message and configuration after remote preparation.
            const dispatch = await admin.rpc('dispatch_outreach_reply', { p_command_id: value.commandId, p_claim_token: claim.claimToken })
            if (dispatch.error || typeof dispatch.data !== 'boolean') {
              // No provider call occurred: even an ambiguous database response cannot justify dispatch.
              await finish('failed', 'prepare_unavailable')
            } else if (dispatch.data) {
              let outcome: z.infer<typeof outcomeSchema> = { status: 'unknown', remoteMessageId: null }
              try {
                const sent = outcomeSchema.safeParse(await provider.send(prepared.prepared, options))
                if (sent.success) outcome = sent.data
              } catch { /* Once dispatch starts, ambiguity is durable and must never trigger a retry. */ }
              await finish(outcome.status, outcome.status === 'unknown' ? 'dispatch_unknown' : outcome.status === 'failed' ? 'dispatch_rejected' : undefined,
                outcome.status === 'sent' ? outcome.remoteMessageId : null)
            }
          }
        }
      }
      // Provider work may outlive the initial user client's shared deadline. Reverify the bearer,
      // then read durable state; neither provider success nor an old enqueue result is a receipt.
      return handle(async (_request, freshClient) => {
        const result = await freshClient.rpc('read_outreach_reply', { p_client_id: value.clientId, p_conversation_id: id, p_command_id: value.commandId })
        checkDatabaseError(result.error)
        const command = projectCommand(result.data, id, value.commandId, value.bodyText)
        return json({ command, conversation: sendingState(await readDetail(freshClient, value.clientId, id)) })
      })(request)
    })(request),
  }
}
