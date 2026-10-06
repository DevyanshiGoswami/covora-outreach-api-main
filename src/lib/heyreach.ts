import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ReplyProviderContext, ScopedReplyOptions, PrepareReason, SendOutcome } from './outreach-reply-types'

// Single source for LinkedIn conversation execution. Verified against the official
// Postman collection (GetChatroom/GetConversationsV3/SendMessage) on 2026-10-03.
const BASE = 'https://api.heyreach.io/api/public'
const date = z.string().refine(value => Number.isFinite(Date.parse(value)))
const profile = z.string().url().refine(value => {
  const url = new URL(value)
  return url.protocol === 'https:' && ['linkedin.com', 'www.linkedin.com'].includes(url.hostname) && url.pathname.startsWith('/in/') && !url.username && !url.password
})
const accountStatusSchema = z.object({
  accountId: z.number().int().positive(), status: z.string(),
  failureReason: z.string().nullable().optional(),
  profile: z.object({ profileUrl: profile }).nullable().optional(),
})
// The official collection shows ME and null; other values need a verified sample.
// The official reply-handling guide identifies non-ME as the correspondent.
export const linkedinMessageSchema = z.object({ createdAt: date, body: z.string().max(100000), subject: z.string().optional(), sender: z.literal('ME').nullable() })
const chatSchema = z.object({
  id: z.string().min(1).max(2000), linkedInAccountId: z.number().int().positive(),
  groupChat: z.boolean(), blockedByMe: z.boolean(), blockedByParticipant: z.boolean(),
  lastMessageAt: date,
  campaignId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  correspondentProfile: z.object({ profileUrl: profile, firstName: z.string().optional(), lastName: z.string().optional() }),
  linkedInAccount: z.object({ id: z.number().int().positive(), authIsValid: z.boolean(), profileUrl: profile }),
  messages: z.array(linkedinMessageSchema).max(500),
})
export type LinkedinChat = z.infer<typeof chatSchema>

export function linkedinMessageFingerprint(message: { createdAt: string; body: string; sender: string | null }): string {
  return createHash('sha256').update(JSON.stringify([new Date(message.createdAt).toISOString(), message.body, message.sender])).digest('hex')
}
function sameProfile(a: string, b: string) {
  const left = profile.safeParse(a), right = profile.safeParse(b)
  return left.success && right.success && new URL(left.data).pathname.replace(/\/$/, '') === new URL(right.data).pathname.replace(/\/$/, '')
}
function deadline(options: ScopedReplyOptions) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 8000, 12000)))
  return options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
}
async function read(path: string, options: ScopedReplyOptions, signal: AbortSignal, body?: unknown): Promise<unknown> {
  signal.throwIfAborted()
  const response = await (options.fetch ?? fetch)(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'X-API-KEY': options.apiKey, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', cache: 'no-store', signal,
  })
  if (!response.ok) throw new Error('Conversation read unavailable')
  return await response.json() as unknown
}
export async function prepareScopedLinkedinReply(context: ReplyProviderContext, options: ScopedReplyOptions): Promise<PrepareReason | null> {
  const id = Number(context.remoteSenderId)
  if (!/^[1-9]\d*$/.test(context.remoteSenderId) || !Number.isSafeInteger(id) || !context.remoteConversationId || !context.latestMessageFingerprint
    || !context.remoteCampaignId || !campaignIds([context.remoteCampaignId])) return 'identity_mismatch'
  const signal = deadline(options)
  const account = z.object({ id: z.number(), authIsValid: z.boolean(), profileUrl: profile }).safeParse(await read(`/li_account/GetById?accountId=${id}`, options, signal))
  if (!account.success || account.data.id !== id || !sameProfile(account.data.profileUrl, context.senderAddress)) return 'identity_mismatch'
  if (!account.data.authIsValid) return 'unavailable'
  // The official connection-status endpoint is authoritative; isActive is not
  // proof of authentication. Its documented provider cache lasts 10 seconds.
  const connection = accountStatusSchema.safeParse(await read(`/li_account/GetAccountStatus/${id}`, options, signal))
  if (!connection.success) return 'unavailable'
  if (connection.data.accountId !== id || connection.data.profile && !sameProfile(connection.data.profile.profileUrl, context.senderAddress)) return 'identity_mismatch'
  if (connection.data.status !== 'Connected' || connection.data.failureReason?.trim()) return 'unavailable'
  const chat = chatSchema.safeParse(await read(`/inbox/GetChatroom/${id}/${encodeURIComponent(context.remoteConversationId)}`, options, signal))
  if (!chat.success || chat.data.id !== context.remoteConversationId || chat.data.linkedInAccountId !== id
    || chat.data.linkedInAccount.id !== id || !sameProfile(chat.data.linkedInAccount.profileUrl, context.senderAddress)
    || !sameProfile(chat.data.correspondentProfile.profileUrl, context.contactAddress)) return 'identity_mismatch'
  if (chat.data.groupChat || chat.data.blockedByMe || chat.data.blockedByParticipant || !chat.data.linkedInAccount.authIsValid) return 'unavailable'
  if (chat.data.campaignId !== undefined && String(chat.data.campaignId) !== context.remoteCampaignId) return 'identity_mismatch'
  // GetChatroom does not document campaign ownership. Prove this exact thread
  // through the documented V3 sender/campaign/lead filters before dispatch.
  const proof = await listScopedLinkedinConversations(context.remoteSenderId, context.senderAddress,
    [context.remoteCampaignId], null, { ...options, signal }, context.contactAddress)
  const scoped = proof.items.find(item => item.id === context.remoteConversationId)
  if (!scoped || !sameProfile(scoped.correspondentProfile.profileUrl, context.contactAddress)) return 'identity_mismatch'
  if (scoped.groupChat || scoped.blockedByMe || scoped.blockedByParticipant || !scoped.linkedInAccount.authIsValid) return 'unavailable'
  const latest = [...chat.data.messages].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
    || linkedinMessageFingerprint(b).localeCompare(linkedinMessageFingerprint(a)))[0]
  if (!latest || Date.parse(latest.createdAt) !== Date.parse(chat.data.lastMessageAt)
    || linkedinMessageFingerprint(latest) !== context.latestMessageFingerprint) return 'changed'
  const scopedLatest = [...scoped.messages].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
    || linkedinMessageFingerprint(b).localeCompare(linkedinMessageFingerprint(a)))[0]
  if (!scopedLatest || Date.parse(scopedLatest.createdAt) !== Date.parse(scoped.lastMessageAt)
    || linkedinMessageFingerprint(scopedLatest) !== context.latestMessageFingerprint) return 'changed'
  return null
}
export async function sendScopedLinkedinReply(context: ReplyProviderContext, options: ScopedReplyOptions): Promise<SendOutcome> {
  try {
    if (!context.remoteCampaignId || !campaignIds([context.remoteCampaignId])) return { status: 'failed', remoteMessageId: null }
    const signal = deadline(options)
    if (signal.aborted) return { status: 'failed', remoteMessageId: null }
    const response = await (options.fetch ?? fetch)(`${BASE}/inbox/SendMessage`, {
      method: 'POST', headers: { 'X-API-KEY': options.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ linkedInAccountId: Number(context.remoteSenderId), conversationId: context.remoteConversationId, message: context.bodyText, subject: context.subject }),
      redirect: 'error', cache: 'no-store', signal,
    })
    if ([400, 401, 403, 404, 422, 429].includes(response.status)) return { status: 'failed', remoteMessageId: null }
    // An unexpected success payload is not a delivery receipt. The documented
    // empty body confirms acceptance only, never recipient delivery.
    if (response.status !== 200 || (await response.text()).trim() !== '') return { status: 'unknown', remoteMessageId: null }
    return { status: 'sent', remoteMessageId: null }
  } catch { return { status: 'unknown', remoteMessageId: null } }
}

function campaignIds(values: readonly string[]): number[] | null {
  if (values.length > 100 || new Set(values).size !== values.length
    || values.some(value => typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) return null
  return values.map(Number)
}

export async function listScopedLinkedinConversations(senderId: string, senderProfile: string, approvedCampaignIds: readonly string[], cursor: string | null, options: ScopedReplyOptions, leadProfile?: string): Promise<{ items: LinkedinChat[]; nextCursor: string | null }> {
  const id = Number(senderId)
  if (!/^[1-9]\d*$/.test(senderId) || !Number.isSafeInteger(id) || !profile.safeParse(senderProfile).success) throw new Error('Conversation binding unavailable')
  const approved = campaignIds(approvedCampaignIds)
  if (!approved || leadProfile !== undefined && !profile.safeParse(leadProfile).success) throw new Error('Conversation campaign unavailable')
  // Empty means no permission. Never send an empty provider filter, which could
  // expand to the sender's whole personal/business inbox.
  if (!approved.length) return { items: [], nextCursor: null }
  const response = z.object({ items: z.array(chatSchema).max(100), hasNextPage: z.boolean(), nextCursor: z.string().max(4000).nullable() }).parse(await read('/inbox/GetConversationsV3', options, deadline(options), {
    limit: 50, cursor, filters: { linkedInAccountIds: [id], campaignIds: approved, ...(leadProfile ? { leadProfileUrl: leadProfile } : {}) },
  }))
  if (response.items.some(chat => chat.linkedInAccountId !== id || chat.linkedInAccount.id !== id || !sameProfile(chat.linkedInAccount.profileUrl, senderProfile)
    || !chat.campaignId || !approved.includes(chat.campaignId) || leadProfile !== undefined && !sameProfile(chat.correspondentProfile.profileUrl, leadProfile))
    || (response.hasNextPage && (!response.nextCursor || response.nextCursor === cursor))) throw new Error('Conversation scope mismatch')
  return { items: response.items, nextCursor: response.hasNextPage ? response.nextCursor : null }
}
