import 'server-only'
import { z } from 'zod'
import { instantlyTransport } from './instantly-transport'

/** Scoped account, results and existing-thread reply adapter. Portal campaign creation lives in portal-outreach-provider; no other campaign mutation,
 * mailbox provisioning, OAuth setup or shared credential fallback is exported. */
const BASE_URL = 'https://api.instantly.ai/api/v2'

export type ScopedAccountState = 'connected' | 'paused' | 'maintenance' | 'setting_up' | 'needs_attention'
export type ScopedAccountObservation =
  | { state: ScopedAccountState; error: null }
  | { state: null; error: 'check_unavailable' | 'scope_mismatch' | 'identity_mismatch' }

const scopedEmail = z.string().trim().toLowerCase().pipe(z.email().max(254))
const scopedAccountSchema = z.object({
  email: scopedEmail,
  organization: z.uuid(),
  status: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(-1), z.literal(-2), z.literal(-3)]),
  setup_pending: z.boolean(),
})

/** Verify a dedicated key's workspace before reading one mailbox; never use the shared legacy key. */
export async function verifyScopedInstantlyAccount(email: string, options: {
  apiKey: string
  expectedWorkspaceId: string
  fetch?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<ScopedAccountObservation> {
  const unavailable = { state: null, error: 'check_unavailable' } as const
  const address = scopedEmail.safeParse(email)
  if (!address.success || !z.uuid().safeParse(options.expectedWorkspaceId).success || !options.apiKey.trim()) return unavailable
  try {
    const deadline = AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 8000, 8000)))
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline
    const read = async (path: string) => {
      signal.throwIfAborted()
      return (options.fetch ?? instantlyTransport())(`${BASE_URL}${path}`, {
        method: 'GET', headers: { Authorization: `Bearer ${options.apiKey}` },
        cache: 'no-store', redirect: 'error', signal,
      })
    }
    const workspaceResponse = await read('/workspaces/current')
    if (!workspaceResponse.ok) return unavailable
    const workspace = z.object({ id: z.uuid() }).safeParse(await workspaceResponse.json())
    if (!workspace.success) return unavailable
    if (workspace.data.id !== options.expectedWorkspaceId) return { state: null, error: 'scope_mismatch' }
    const accountResponse = await read(`/accounts/${encodeURIComponent(address.data)}`)
    if (accountResponse.status === 404) return { state: 'needs_attention', error: null }
    if (!accountResponse.ok) return unavailable
    const account = scopedAccountSchema.safeParse(await accountResponse.json())
    if (!account.success) return unavailable
    if (account.data.organization !== options.expectedWorkspaceId) return { state: null, error: 'scope_mismatch' }
    if (account.data.email !== address.data) return { state: null, error: 'identity_mismatch' }
    const state: ScopedAccountState = account.data.setup_pending ? 'setting_up'
      : account.data.status === 1 ? 'connected'
        : account.data.status === 2 ? 'paused'
          : account.data.status === 3 ? 'maintenance' : 'needs_attention'
    return { state, error: null }
  } catch {
    return unavailable
  }
}

export class InstantlyError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'InstantlyError'
    this.status = status
  }
}

export interface InstantlyReadOptions {
  /** Explicit tenant key for scoped mirror reads; an empty key never falls back. */
  apiKey?: string
  /** Absolute wall-clock deadline, shared with the cron tick. */
  deadline?: number
  /** Reserve budget for EVERY physical request, including 429 retries. */
  beforeAttempt?: () => Promise<void>
}

async function instantlyFetch<T>(
  path: string,
  init?: { method?: string; body?: unknown; searchParams?: Record<string, string>; redactErrors?: boolean } & InstantlyReadOptions,
): Promise<T> {
  const key = init?.apiKey?.trim()
  if (!key) throw new InstantlyError('A dedicated sending-engine credential is required', 0)

  const url = new URL(`${BASE_URL}${path}`)
  for (const [k, v] of Object.entries(init?.searchParams ?? {})) url.searchParams.set(k, v)

  for (let attempt = 0; attempt < 3; attempt++) {
    if (init?.deadline !== undefined && Date.now() >= init.deadline) {
      throw new InstantlyError('Instantly request deadline reached', 408)
    }
    await init?.beforeAttempt?.()
    const remaining = init?.deadline === undefined ? 30_000 : init.deadline - Date.now()
    if (remaining <= 0) throw new InstantlyError('Instantly request deadline reached', 408)
    const res = await instantlyTransport()(url, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(Math.min(30_000, remaining)),
      redirect: 'error', cache: 'no-store',
    })
    if (res.status === 429 && attempt < 2) {
      // Workspace-level limit — back off and retry (reads and idempotent
      // creates only reach here; we never blind-retry anything destructive).
      const delay = 2_000 * (attempt + 1)
      if (init?.deadline !== undefined && Date.now() + delay >= init.deadline) {
        throw new InstantlyError('Instantly request deadline reached', 408)
      }
      await new Promise((r) => setTimeout(r, delay))
      continue
    }
    if (!res.ok) {
      throw new InstantlyError(`Sending-engine read failed (${res.status})`, res.status)
    }
    return (await res.json().catch(() => ({}))) as T
  }
  throw new InstantlyError(`Instantly ${path} rate-limited after retries`, 429)
}

export interface InstantlyPage<T> {
  items: T[]
  next_starting_after?: string
}

export interface InstantlyCampaign {
  id: string
  name: string
  status: number
  organization?: string
  email_list?: string[]
  email_tag_list?: string[] | null
  timestamp_created?: string
  timestamp_updated?: string
  campaign_schedule?: {
    start_date?: string | null
    end_date?: string | null
    schedules: Array<{
      name: string
      timing: { from: string; to: string }
      days: Record<string, boolean>
      timezone: string
    }>
  }
  /** Only the first sequence is used by the API. Step delay is AFTER that step. */
  sequences?: Array<{
    steps: Array<{
      type: 'email'
      delay: number
      delay_unit?: 'minutes' | 'hours' | 'days'
      variants: Array<{ subject: string; body: string; v_disabled?: boolean }>
    }>
  }>
}

export async function listCampaignsPage(
  startingAfter?: string,
  options?: InstantlyReadOptions,
): Promise<InstantlyPage<InstantlyCampaign>> {
  return instantlyFetch('/campaigns', {
    ...options,
    redactErrors: true,
    searchParams: {
      limit: '100',
      include_ai_sales_agent_campaigns: 'true',
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    },
  })
}

/** Fail explicitly on a stuck cursor or safety cap, never present a partial picker as complete. */
export async function listCampaigns(options?: InstantlyReadOptions): Promise<InstantlyCampaign[]> {
  const out: InstantlyCampaign[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const data = await listCampaignsPage(cursor, options)
    out.push(...data.items)
    if (!data.next_starting_after || data.items.length === 0) return out
    if (seen.has(data.next_starting_after)) throw new InstantlyError('Campaign pagination did not advance', 502)
    seen.add(data.next_starting_after)
    cursor = data.next_starting_after
  }
  throw new InstantlyError('Campaign pagination exceeded safety limit', 502)
}

export async function getCampaign(
  campaignId: string,
  options?: InstantlyReadOptions,
): Promise<InstantlyCampaign> {
  return instantlyFetch(`/campaigns/${encodeURIComponent(campaignId)}`, { ...options, redactErrors: true })
}

/** Current sender configuration is checked on every mirror visit. Assignment
 * approval is explicit in the database; names and copy never establish it.
 * https://developer.instantly.ai/api-reference/schemas/campaign
 */
export function scopedCampaignSenders(campaign: InstantlyCampaign, expectedCampaignId: string,
  expectedWorkspaceId: string, approvedSenders: readonly string[]): ReadonlySet<string> {
  const config = z.object({ id: z.uuid(), organization: z.uuid().optional(), status: z.number(),
    email_list: z.array(scopedEmail).max(500),
    // Unresolved tags can expand the campaign beyond its explicit email list.
    // An omitted/empty tag list is supported; no account-tag discovery occurs.
    email_tag_list: z.array(z.string()).max(0).nullish(),
  }).safeParse(campaign)
  const approved = z.array(scopedEmail).max(500).safeParse(approvedSenders)
  if (!config.success || !approved.success || config.data.id !== expectedCampaignId
    || (config.data.organization !== undefined && config.data.organization !== expectedWorkspaceId)
    || (config.data.email_list.length === 0 && config.data.status !== 0)
    || config.data.email_list.some(email => !approved.data.includes(email))) {
    throw new InstantlyError('Assigned campaign sender scope is unavailable', 403)
  }
  // A senderless draft may expose its assigned campaign data, but an empty
  // scope never authorizes message reads. The worker leaves reply cursors alone.
  return new Set(config.data.email_list)
}

export interface InstantlyLead {
  email: string
  status: number
  email_open_count: number | null
  email_reply_count: number | null
  email_click_count: number | null
  lt_interest_status: number | null
  id?: string
  campaign?: string | null
  first_name?: string | null
  last_name?: string | null
  company_name?: string | null
  job_title?: string | null
  verification_status?: number | null
  timestamp_created?: string
  timestamp_updated?: string
  timestamp_last_contact?: string | null
  timestamp_last_open?: string | null
  timestamp_last_reply?: string | null
  timestamp_last_interest_change?: string | null
  timestamp_last_click?: string | null
  timestamp_last_touch?: string | null
  last_step_from?: string | null
  last_step_id?: string | null
  last_step_timestamp_executed?: string | null
  email_replied_step?: number | null
  email_opened_step?: number | null
  email_clicked_step?: number | null
  status_summary?: {
    lastStep?: { from?: string; stepID?: string; timestamp_executed?: string }
    domain_complete?: boolean
  } | null
  /** These are lead profile/custom variables; only allowlisted display fields may be mirrored. */
  payload?: Record<string, unknown> | null
}

export type InstantlyLeadPageItem = Omit<InstantlyLead, 'email'> & { email: string | null }

/** One read-only POST page lets workers checkpoint arbitrarily large campaigns. */
export async function listCampaignLeadsPage(
  campaignId: string,
  startingAfter?: string,
  options?: number | InstantlyReadOptions,
): Promise<InstantlyPage<InstantlyLeadPageItem>> {
  return instantlyFetch('/leads/list', {
    method: 'POST',
    redactErrors: true,
    ...(typeof options === 'number' ? { deadline: options } : options),
    body: {
      campaign: campaignId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    },
  })
}

export interface InstantlyCampaignAnalytics {
  campaign_id?: string
  campaign_status?: number
  new_leads_contacted_count?: number
  open_count_unique?: number
  /** Provider already excludes auto-replies: do NOT subtract automatic replies again. */
  reply_count_unique?: number
  reply_count_automatic?: number
  reply_count_automatic_unique?: number
  link_click_count?: number
  link_click_count_unique?: number
  total_opportunities?: number
  total_opportunity_value?: number
  leads_count?: number
  contacted_count?: number
  emails_sent_count?: number
  open_count?: number
  reply_count?: number
  bounced_count?: number
  unsubscribed_count?: number
  completed_count?: number
}

export async function getCampaignAnalytics(
  campaignId: string,
  options?: InstantlyReadOptions,
): Promise<InstantlyCampaignAnalytics | null> {
  const data = await instantlyFetch<InstantlyCampaignAnalytics[]>('/campaigns/analytics', {
    ...options,
    searchParams: { id: campaignId },
  })
  if (!Array.isArray(data) || data.length > 0 && (!data[0] || typeof data[0] !== 'object' || Array.isArray(data[0]))) {
    throw new InstantlyError('Sending-engine analytics response is invalid', 502)
  }
  return data.length > 0 ? data[0] : null
}

export interface InstantlyDailyCampaignAnalytics {
  date: string
  sent?: number
  contacted?: number
  new_leads_contacted?: number
  opened?: number
  unique_opened?: number
  replies?: number
  unique_replies?: number
  replies_automatic?: number
  unique_replies_automatic?: number
  clicks?: number
  unique_clicks?: number
  opportunities?: number
  unique_opportunities?: number
}

export async function getDailyCampaignAnalytics(
  campaignId: string,
  startDate?: string,
  endDate?: string,
  options?: InstantlyReadOptions,
): Promise<InstantlyDailyCampaignAnalytics[]> {
  return instantlyFetch('/campaigns/analytics/daily', {
    ...options,
    redactErrors: true,
    searchParams: {
      campaign_id: campaignId,
      ...(startDate ? { start_date: startDate } : {}),
      ...(endDate ? { end_date: endDate } : {}),
    },
  })
}

export interface InstantlyCampaignStepAnalytics extends Omit<InstantlyDailyCampaignAnalytics, 'date'> {
  step: string | null
  /** Zero based: 0 = A, 1 = B. */
  variant: string | null
  meetings_booked?: number
  won?: number
}

export async function getCampaignStepAnalytics(
  campaignId: string,
  options?: InstantlyReadOptions,
): Promise<InstantlyCampaignStepAnalytics[]> {
  return instantlyFetch('/campaigns/analytics/steps', {
    ...options,
    redactErrors: true,
    searchParams: { campaign_id: campaignId, include_opportunities_count: 'true' },
  })
}

export interface InstantlyEmail {
  id: string
  organization_id?: string
  timestamp_created: string
  timestamp_email: string
  subject: string
  from_address_email?: string | null
  to_address_email_list: string
  body: { text?: string; html?: string }
  campaign_id?: string | null
  lead?: string | null
  lead_id?: string | null
  eaccount: string
  /** 1 campaign sent, 2 received, 3 manually sent, 4 scheduled (not sent). */
  ue_type?: number | null
  step?: string | null
  is_unread?: number | null
  is_auto_reply?: number | null
  i_status?: number | null
  thread_id?: string | null
}

export interface ListInstantlyEmailsInput extends InstantlyReadOptions {
  campaignId: string
  emailType?: 'received' | 'sent' | 'manual'
  minTimestampCreated?: string
  maxTimestampCreated?: string
  startingAfter?: string
  lead?: string
  threadId?: string
  limit?: number
  /** Required: reserve workspace-wide budget, including every retry. */
  beforeAttempt: () => Promise<void>
}

/**
 * One page only: callers own durable pagination and the shared ≤10/min budget.
 * Explicitly request bodies and all messages, not just the latest of a thread.
 * ⚠️ VERIFY: timestamp boundary/tie behavior needs a nonempty multi-page live sample.
 */
export async function listEmails(input: ListInstantlyEmailsInput): Promise<InstantlyPage<InstantlyEmail>> {
  const limit = input.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new InstantlyError('Email page limit must be between 1 and 100', 400)
  }
  return instantlyFetch('/emails', {
    redactErrors: true,
    apiKey: input.apiKey,
    beforeAttempt: input.beforeAttempt,
    deadline: input.deadline,
    searchParams: {
      campaign_id: input.campaignId,
      limit: String(limit),
      mode: 'emode_all',
      preview_only: 'false',
      latest_of_thread: 'false',
      sort_order: 'desc',
      ...(input.emailType ? { email_type: input.emailType } : {}),
      ...(input.minTimestampCreated ? { min_timestamp_created: input.minTimestampCreated } : {}),
      ...(input.maxTimestampCreated ? { max_timestamp_created: input.maxTimestampCreated } : {}),
      ...(input.startingAfter ? { starting_after: input.startingAfter } : {}),
      ...(input.lead ? { lead: input.lead } : {}),
      ...(input.threadId ? { search: `thread:${input.threadId}` } : {}),
    },
  })
}

// Reply requests deliberately bypass instantlyFetch: a transport retry can send twice.
// Verified against official Email list/get/reply schemas on 2026-10-03; live sending stays rollout-gated.
import type { ReplyProviderContext, ScopedReplyOptions, PrepareReason, SendOutcome } from './outreach-reply-types'

export async function verifyScopedInstantlyWorkspace(expectedId: string, options: ScopedReplyOptions): Promise<boolean> {
  if (!z.uuid().safeParse(expectedId).success || !options.apiKey.trim()) return false
  try {
    const response = await (options.fetch ?? instantlyTransport())(`${BASE_URL}/workspaces/current`, {
      headers: { Authorization: `Bearer ${options.apiKey}` }, signal: replySignal(options), redirect: 'error', cache: 'no-store',
    })
    if (!response.ok) return false
    const workspace = z.object({ id: z.uuid() }).safeParse(await response.json())
    return workspace.success && workspace.data.id === expectedId
  } catch { return false }
}

const replyEmailSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), eaccount: scopedEmail, thread_id: z.string().min(1),
  campaign_id: z.string().nullable().optional(), lead: scopedEmail,
  from_address_email: scopedEmail, to_address_email_list: z.string(), ue_type: z.number(),
})
function replySignal(options: ScopedReplyOptions) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 8000, 12000)))
  return options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
}
function matchesReplyScope(email: z.infer<typeof replyEmailSchema>, context: ReplyProviderContext) {
  return email.organization_id === context.remoteWorkspaceId && email.eaccount === context.senderAddress
    && email.thread_id === context.remoteConversationId && email.lead === context.contactAddress
}
export async function prepareScopedInstantlyReply(context: ReplyProviderContext, options: ScopedReplyOptions): Promise<PrepareReason | null> {
  if (!context.remoteReplyToId || !context.remoteLatestMessageId || !context.remoteCampaignId
    || context.remoteSenderId !== context.senderAddress || !scopedEmail.safeParse(context.senderAddress).success
    || !scopedEmail.safeParse(context.contactAddress).success) return 'identity_mismatch'
  const signal = replySignal(options)
  const read = async (path: string) => {
    signal.throwIfAborted()
    const response = await (options.fetch ?? instantlyTransport())(`${BASE_URL}${path}`, { method: 'GET', headers: { Authorization: `Bearer ${options.apiKey}` }, cache: 'no-store', redirect: 'error', signal })
    if (!response.ok) throw new Error('Reply preparation unavailable')
    return await response.json() as unknown
  }
  const workspace = z.object({ id: z.uuid() }).safeParse(await read('/workspaces/current'))
  if (!workspace.success || workspace.data.id !== context.remoteWorkspaceId) return 'identity_mismatch'
  const account = scopedAccountSchema.safeParse(await read(`/accounts/${encodeURIComponent(context.senderAddress)}`))
  if (!account.success || account.data.email !== context.senderAddress || account.data.organization !== context.remoteWorkspaceId) return 'identity_mismatch'
  if (account.data.status !== 1 || account.data.setup_pending) return 'unavailable'
  const target = replyEmailSchema.safeParse(await read(`/emails/${encodeURIComponent(context.remoteReplyToId)}`))
  if (!target.success || target.data.id !== context.remoteReplyToId || !matchesReplyScope(target.data, context)
    || target.data.campaign_id !== context.remoteCampaignId || target.data.ue_type !== 2
    || target.data.from_address_email !== context.contactAddress
    || target.data.to_address_email_list.toLowerCase().split(',').map(s => s.trim()).includes(context.senderAddress) === false) return 'identity_mismatch'
  const query = new URLSearchParams({ search: `thread:${context.remoteConversationId}`, eaccount: context.senderAddress, lead: context.contactAddress, limit: '1', latest_of_thread: 'true', mode: 'emode_all', preview_only: 'false', sort_order: 'desc' })
  const latest = z.object({ items: z.array(replyEmailSchema).length(1) }).safeParse(await read(`/emails?${query}`))
  if (!latest.success || !matchesReplyScope(latest.data.items[0], context)) return 'identity_mismatch'
  if (latest.data.items[0].id !== context.remoteLatestMessageId) return 'changed'
  return null
}
export async function sendScopedInstantlyReply(context: ReplyProviderContext, options: ScopedReplyOptions): Promise<SendOutcome> {
  try {
    const signal = replySignal(options)
    if (signal.aborted) return { status: 'failed', remoteMessageId: null }
    const response = await (options.fetch ?? instantlyTransport())(`${BASE_URL}/emails/reply`, {
      method: 'POST', headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ eaccount: context.senderAddress, reply_to_uuid: context.remoteReplyToId, subject: context.subject, body: { text: context.bodyText } }),
      cache: 'no-store', redirect: 'error', signal,
    })
    if ([400, 401, 402, 403, 404, 422, 429].includes(response.status)) return { status: 'failed', remoteMessageId: null }
    if (response.status !== 200) return { status: 'unknown', remoteMessageId: null }
    const reply = replyEmailSchema.safeParse(await response.json())
    if (!reply.success || !matchesReplyScope(reply.data, context) || reply.data.ue_type !== 3
      || reply.data.from_address_email !== context.senderAddress
      || reply.data.to_address_email_list.trim().toLowerCase() !== context.contactAddress) return { status: 'unknown', remoteMessageId: null }
    return { status: 'sent', remoteMessageId: reply.data.id }
  } catch { return { status: 'unknown', remoteMessageId: null } }
}
