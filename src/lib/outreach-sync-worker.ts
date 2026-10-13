import 'server-only'
import { runtimeConfiguration } from './runtime-config'
import { randomUUID } from 'node:crypto'

import type { CronContext } from '@/lib/cron-worker'
import type { Database } from '@/lib/database.types'
import { campaignStatus } from '@/lib/outreach-metrics'
import {
  getCampaign, getCampaignAnalytics, getDailyCampaignAnalytics,
  InstantlyError, listCampaignLeadsPage, listEmails,
  scopedCampaignSenders, verifyScopedInstantlyWorkspace, type InstantlyCampaign,
  type InstantlyEmail, type InstantlyPage, type InstantlyReadOptions,
} from '@/lib/instantly'
import {
  count, leadForAssignment, messageForAssignment, neutralText, normalizedSchedule,
  normalizedStats, normalizedTotals, record, replyCheckpoint, retryDelayMs, sequencePlainText, syncDue,
} from '@/lib/outreach-sync-data'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { syncLinkedinConversations } from '@/lib/outreach-conversation-worker'

type Admin = ReturnType<typeof createSupabaseAdminClient>
type Campaign = Database['public']['Tables']['outreach_campaigns']['Row']
type State = Database['public']['Tables']['outreach_sync_state']['Row']
type Queue = Database['public']['Tables']['outreach_fetch_queue']['Row']
type EmailScope = { workspaceId: string; approvedSenders: ReadonlySet<string> }
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const MIN_START_MS = 7_000

class Deferred extends Error {}

function beforeDeadline(deadline: number) {
  if (Date.now() >= deadline) throw new Deferred()
}

function check(error: { message: string } | null) {
  // Supabase errors can contain row values. No PII/provider payload in cron
  // response bodies, heartbeat notes, or stored retry messages.
  if (error) throw new Error('Outreach mirror database operation failed')
}

function assertPage<T>(page: InstantlyPage<T>, cursor?: string | null) {
  if (!Array.isArray(page.items) || page.items.length > 100
    || (page.next_starting_after !== undefined && typeof page.next_starting_after !== 'string')) {
    throw new Error('Sending engine returned an invalid page')
  }
  if (page.items.length > 0 && page.next_starting_after && page.next_starting_after === cursor) {
    throw new Error('Sending engine pagination did not advance')
  }
}

async function updateState(admin: Admin, state: State, patch: Database['public']['Tables']['outreach_sync_state']['Update']) {
  const { error } = await admin.from('outreach_sync_state').update(patch).eq('campaign_id', state.campaign_id).eq('client_id', state.client_id)
  check(error)
  Object.assign(state, patch)
}

/** Save an already scoped observation before history can defer the campaign.
 * Status freshness does not imply that its metrics or schedule were refreshed. */
async function refreshStatus(admin: Admin, campaign: Campaign, remote: InstantlyCampaign) {
  const status = campaignStatus(remote.status)
  const completed_at = remote.status === 3 ? campaign.completed_at ?? new Date().toISOString() : null
  if (campaign.status === status && campaign.completed_at === completed_at) return
  const patch = { status, completed_at }
  check((await admin.from('outreach_campaigns').update(patch).eq('id', campaign.id).eq('client_id', campaign.client_id)).error)
  Object.assign(campaign, patch)
}

async function refreshMetadata(admin: Admin, campaign: Campaign, state: State, remote: InstantlyCampaign, options: InstantlyReadOptions & { deadline: number }) {
  const { deadline } = options
  const totals = await getCampaignAnalytics(campaign.provider_campaign_id, options)
  if (remote.id !== campaign.provider_campaign_id || !remote.name || typeof remote.status !== 'number') {
    throw new Error('Sending engine campaign did not match its assignment')
  }
  if ((!totals && remote.status !== 0 && remote.status !== 1) || (totals?.campaign_id && totals.campaign_id !== campaign.provider_campaign_id)) {
    throw new Error('Sending engine totals did not match their assignment')
  }
  const now = new Date().toISOString()
  const steps = remote.sequences?.[0]?.steps
  if (steps !== undefined) {
    if (!Array.isArray(steps) || steps.length > 100 || steps.some((step) => !Array.isArray(step.variants) || step.variants.length > 100)) {
      throw new Error('Sending engine sequence shape is unsupported')
    }
    const rows = steps.flatMap((step, index) => {
      if (step.type !== 'email' || !Number.isFinite(step.delay) || step.delay < 0) throw new Error('Sending engine step shape is unsupported')
      const divisor = step.delay_unit === 'minutes' ? 1440 : step.delay_unit === 'hours' ? 24 : 1
      if (step.delay_unit !== undefined && !['minutes', 'hours', 'days'].includes(step.delay_unit)) throw new Error('Sending engine delay unit is unsupported')
      return step.variants.map((variant, variantIndex) => ({
        campaign_id: campaign.id, client_id: campaign.client_id, step: index + 1, variant: variantIndex,
        subject: neutralText(variant.subject), body_text: sequencePlainText(variant.body), delay_days: step.delay / divisor,
      }))
    })
    for (let index = 0; index < rows.length; index += 500) {
      beforeDeadline(deadline)
      check((await admin.from('outreach_campaign_steps').upsert(rows.slice(index, index + 500), { onConflict: 'campaign_id,step,variant' })).error)
    }
    const existing: Array<{ step: number; variant: number }> = []
    for (let offset = 0; ; offset += 500) {
      beforeDeadline(deadline)
      const page = await admin.from('outreach_campaign_steps').select('step, variant').eq('campaign_id', campaign.id)
        .order('step').order('variant').range(offset, offset + 499)
      check(page.error)
      existing.push(...page.data ?? [])
      if ((page.data?.length ?? 0) < 500) break
    }
    const current = new Set(rows.map((row) => `${row.step}:${row.variant}`))
    for (const stale of existing) {
      if (!current.has(`${stale.step}:${stale.variant}`)) {
        beforeDeadline(deadline)
        check((await admin.from('outreach_campaign_steps').delete().eq('campaign_id', campaign.id).eq('step', stale.step).eq('variant', stale.variant)).error)
      }
    }
  }
  const patch = {
    name: neutralText(remote.name).slice(0, 500) || 'Campaign', status: campaignStatus(remote.status),
    schedule: normalizedSchedule(remote.campaign_schedule),
    // Drafts and newly active campaigns may have no analytics object yet.
    // Keep earlier measurements while other synchronization continues.
    totals: { ...(totals ? normalizedTotals(totals) : record(campaign.totals)),
      analytics_available: totals !== null, positive_replies: await positiveReplies(admin, campaign.id) } as Campaign['totals'], synced_at: now,
    // No provider completion timestamp exists. Retention starts at our first
    // observed completion, conservatively later than the actual end.
    completed_at: remote.status === 3 ? campaign.completed_at ?? now : null,
  }
  check((await admin.from('outreach_campaigns').update(patch).eq('id', campaign.id).eq('client_id', campaign.client_id)).error)
  Object.assign(campaign, patch)
  await updateState(admin, state, { meta_synced_at: now })
}

async function positiveReplies(admin: Admin, campaignId: string) {
  const response = await admin.from('outreach_leads').select('id', { head: true, count: 'exact' })
    .eq('campaign_id', campaignId).in('interest', ['Interested', 'Meeting booked', 'Won'])
  check(response.error)
  return response.count ?? 0
}

async function refreshAnalytics(admin: Admin, campaign: Campaign, state: State, remote: InstantlyCampaign, options: InstantlyReadOptions & { deadline: number }) {
  const { deadline } = options
  // Date-only API bounds are UTC midnight. Tomorrow includes today's data.
  const end = new Date(Date.now() + DAY).toISOString().slice(0, 10)
  // First sync asks for the full available history; subsequent runs restate
  // three UTC dates to pick up delayed replies and provider adjustments.
  let from = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10)
  if (!state.daily_synced_at) {
    if (remote.id !== campaign.provider_campaign_id || !remote.timestamp_created || !Number.isFinite(Date.parse(remote.timestamp_created))) {
      throw new Error('Sending engine campaign start date is unavailable')
    }
    from = new Date(remote.timestamp_created).toISOString().slice(0, 10)
  }
  const daily = await getDailyCampaignAnalytics(campaign.provider_campaign_id, from, end, options)
  if (!Array.isArray(daily)) throw new Error('Sending engine analytics shape is unsupported')
  const rows = daily.map((day) => {
    if (typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(day.date) || !Number.isFinite(Date.parse(day.date))) {
      throw new Error('Sending engine analytics date is invalid')
    }
    const stats = normalizedStats(day)
    return {
      campaign_id: campaign.id, client_id: campaign.client_id, day: day.date.slice(0, 10), sent: stats.sent,
      contacted: stats.contacted, new_contacted: count(day.new_leads_contacted), unique_opened: stats.unique_opened,
      unique_replies: stats.unique_replies, auto_replies: stats.unique_auto_replies,
      unique_clicks: stats.unique_clicks, opportunities: stats.opportunities,
    }
  })
  for (let i = 0; i < rows.length; i += 500) {
    beforeDeadline(deadline)
    check((await admin.from('outreach_campaign_daily').upsert(rows.slice(i, i + 500), { onConflict: 'campaign_id,day' })).error)
  }
  // Step statistics remain unavailable until the provider's step indexing can
  // be tied to sequence copy. Do not request unused step analytics: a missing
  // permission on that endpoint must not block daily results or inbox progress.
  await updateState(admin, state, { daily_synced_at: new Date().toISOString() })
}

async function refreshLeadPage(admin: Admin, campaign: Campaign, state: State, options: InstantlyReadOptions & { deadline: number }) {
  const page = await listCampaignLeadsPage(campaign.provider_campaign_id, state.lead_cursor ?? undefined, options)
  assertPage(page, state.lead_cursor)
  const rows = page.items.map((lead) => leadForAssignment(campaign, lead)).filter((lead) => lead !== null)
  if (rows.length) check((await admin.from('outreach_leads').upsert(rows, { onConflict: 'campaign_id,email' })).error)
  const next = page.items.length > 0 ? page.next_starting_after ?? null : null
  if (!next) {
    const totals = { ...record(campaign.totals), positive_replies: await positiveReplies(admin, campaign.id) } as Database['public']['Tables']['outreach_campaigns']['Row']['totals']
    check((await admin.from('outreach_campaigns').update({ totals }).eq('id', campaign.id)).error)
    campaign.totals = totals
  }
  await updateState(admin, state, { lead_cursor: next, ...(next ? {} : { leads_synced_at: new Date().toISOString() }) })
}

async function saveMessages(admin: Admin, campaign: Campaign, items: InstantlyEmail[], scope: EmailScope) {
  // Validate the entire page before any writes. Even a shared sender may appear
  // in another client's campaign; a sender match never replaces campaign scope.
  const scoped = items.map(item => {
    const address = typeof item?.eaccount === 'string' ? item.eaccount.trim().toLowerCase() : ''
    if (item?.campaign_id !== campaign.provider_campaign_id || !scope.approvedSenders.has(address)
      || (item.organization_id !== undefined && item.organization_id !== scope.workspaceId)) {
      throw new Error('Campaign history scope is unavailable')
    }
    return { ...item, eaccount: address }
  })
  const rows = scoped.map((item) => messageForAssignment(campaign, item)).filter((item) => item !== null)
  if (rows.length) {
    check((await admin.from('outreach_messages').upsert(rows, { onConflict: 'provider_email_id', defaultToNull: false })).error)
  }
  const threadIds = [...new Set(rows.filter((row) => row.direction === 'received' && row.provider_thread_id).map((row) => row.provider_thread_id!))]
  if (threadIds.length) {
    // Completed context jobs remain tombstones. Periodic campaign polling
    // includes sent and received messages, so subsequent follow-ups do not
    // depend on reopening an already fetched thread job.
    check((await admin.from('outreach_fetch_queue').upsert(threadIds.map((threadId) => ({
      campaign_id: campaign.id, client_id: campaign.client_id, provider_thread_id: threadId, lead_email: '',
    })), { onConflict: 'campaign_id,lead_email,provider_thread_id', ignoreDuplicates: true })).error)
  }
  return rows.length
}

async function refreshReplyPage(admin: Admin, campaign: Campaign, state: State, scope: EmailScope, request: InstantlyReadOptions & { deadline: number; beforeAttempt: () => Promise<void> }) {
  const scanStarted = state.reply_scan_started_at ?? new Date().toISOString()
  // Persist the upper bound BEFORE issuing page one. A retry uses exactly the
  // same range, and the first backfill has no lower bound at all.
  if (!state.reply_scan_started_at) await updateState(admin, state, { reply_scan_started_at: scanStarted })
  const page = await listEmails({
    // Poll all campaign messages, including externally sent follow-ups. The
    // mapper excludes scheduled/unknown types, and scope validation still runs
    // over the entire page before any write or checkpoint.
    ...request, campaignId: campaign.provider_campaign_id,
    startingAfter: state.reply_cursor ?? undefined,
    // Overlap the boundary; provider filtering is not documented as inclusive.
    minTimestampCreated: state.reply_watermark ? new Date(Date.parse(state.reply_watermark) - MINUTE).toISOString() : undefined,
    maxTimestampCreated: scanStarted,
  })
  assertPage(page, state.reply_cursor)
  const saved = await saveMessages(admin, campaign, page.items, scope)
  const patch = replyCheckpoint({ cursor: state.reply_cursor, watermark: state.reply_watermark, scanStartedAt: scanStarted,
    nextCursor: page.next_starting_after, itemCount: page.items.length })
  await updateState(admin, state, { ...patch, last_email_kind: 'poll', ...(patch.reply_cursor ? {} : { replies_synced_at: new Date().toISOString() }) })
  return saved
}

async function refreshQueuePage(admin: Admin, campaign: Campaign, job: Queue, scope: EmailScope, request: InstantlyReadOptions & { deadline: number; beforeAttempt: () => Promise<void> }) {
  const page = await listEmails({ ...request, campaignId: campaign.provider_campaign_id,
    startingAfter: job.cursor ?? undefined, lead: job.lead_email || undefined, threadId: job.provider_thread_id || undefined })
  assertPage(page, job.cursor)
  const saved = await saveMessages(admin, campaign, page.items, scope)
  const next = page.items.length > 0 ? page.next_starting_after ?? null : null
  // A webhook delivered during this request has bumped requested_at. Keep
  // its fresh job intact so an in-flight fetch cannot swallow a new reply.
  check((await admin.from('outreach_fetch_queue').update({
    cursor: next, completed_at: next ? null : new Date().toISOString(), attempt_count: 0, last_error: null,
  }).eq('id', job.id).eq('requested_at', job.requested_at)).error)
  return saved
}

/** Durable lease + rolling budget also cover overlapping serverless instances. */
export async function syncOutreach(ctx: CronContext) {
  const result = { campaigns: 0, messages: 0, email_attempts: 0, purged: 0, deferred: 0, failed: 0 }
  if (!runtimeConfiguration().syncEnabled) return { ...result, disabled: true }
  const admin = createSupabaseAdminClient()
  const token = randomUUID()
  const lease = await admin.rpc('acquire_outreach_sync_lock', { p_token: token, p_seconds: 120 })
  check(lease.error)
  if (!lease.data) return { ...result, deferred: 1, already_running: true }
  try {
    // Share the same durable lease; history sync can never dispatch a reply.
    const linkedin = await syncLinkedinConversations(ctx).catch(() => ({ senders: 0, conversations: 0, failed: 1, deferred: 0 }))
    result.failed += linkedin.failed
    result.deferred += linkedin.deferred
    const candidates = await admin.from('outreach_sync_state').select('*, outreach_campaigns!inner(*)')
      .eq('outreach_campaigns.channel', 'email')
      .or(`retry_after.is.null,retry_after.lte.${new Date().toISOString()}`)
      .order('last_served_at', { ascending: true, nullsFirst: true }).order('campaign_id').limit(50)
    check(candidates.error)
    let emailBudgetExhausted = false
    for (const candidate of candidates.data ?? []) {
      if (ctx.timeLeft() < MIN_START_MS) { result.deferred += 1; break }
      const campaign = candidate.outreach_campaigns
      const state: State = candidate
      const previouslyServedAt = state.last_served_at
      try {
        // Once visited, send this campaign to the back of the queue even if
        // its API is failing. Otherwise one bad campaign starves everyone.
        await updateState(admin, state, { last_served_at: new Date().toISOString() })
        const purge = await admin.rpc('purge_outreach_messages', { p_campaign_id: campaign.id, p_token: token })
        check(purge.error)
        if (purge.data) { campaign.messages_purged_at = new Date().toISOString(); result.purged += 1 }
        const deadline = ctx.deadline - 5_000
        const readOptions: InstantlyReadOptions & { deadline: number } = { deadline }
        // An explicit tenant assignment and dedicated credential are required;
        const binding = await admin.from('outreach_reply_workspaces').select('id,remote_workspace_id,credential_ref,sync_enabled')
          .eq('client_id', campaign.client_id).eq('channel', 'email').maybeSingle()
        check(binding.error)
        if (!binding.data) { result.failed += 1; continue }
        {
          if (!binding.data.sync_enabled) continue
          const feature = await admin.from('client_features').select('enabled').eq('client_id', campaign.client_id).eq('feature', 'outreach_app').maybeSingle()
          check(feature.error)
          if (!feature.data?.enabled) continue
          const key = /^OUTREACH_INSTANTLY_[A-Z0-9_]{1,100}$/.test(binding.data.credential_ref) ? process.env[binding.data.credential_ref]?.trim() : null
          if (!key || !await verifyScopedInstantlyWorkspace(binding.data.remote_workspace_id, { apiKey: key, timeoutMs: Math.min(5000, ctx.timeLeft()) })) throw new Error('Workspace history is unavailable')
          readOptions.apiKey = key
        }
        const senders = await admin.from('outreach_reply_senders').select('remote_sender_id,sender_address')
          .eq('client_id', campaign.client_id).eq('workspace_id', binding.data.id).eq('channel', 'email').limit(501)
        check(senders.error)
        // Read authorization is independent of the enabled flag for sending.
        if (!senders.data || senders.data.length > 500
          || senders.data.some(sender => sender.remote_sender_id !== sender.sender_address)) {
          throw new Error('Campaign history sender scope is unavailable')
        }
        const remote = await getCampaign(campaign.provider_campaign_id, readOptions)
        const approvedSenders = senders.data.map(sender => sender.remote_sender_id)
        // Current configuration must still contain only approved tenant senders.
        // Historical messages can belong to an approved sender removed from that
        // configuration; message campaign and returned workspace IDs stay checked.
        const currentCampaignSenders = scopedCampaignSenders(remote, campaign.provider_campaign_id,
          binding.data.remote_workspace_id, approvedSenders)
        await refreshStatus(admin, campaign, remote)
        const scope: EmailScope = { workspaceId: binding.data.remote_workspace_id, approvedSenders: new Set(approvedSenders) }
        const hasTime = () => { if (ctx.timeLeft() < MIN_START_MS) throw new Deferred() }
        const beforeAttempt = async () => {
          hasTime()
          const permit = await admin.rpc('reserve_outreach_email_request', { p_token: token })
          check(permit.error)
          if (!permit.data) { emailBudgetExhausted = true; throw new Deferred() }
          result.email_attempts += 1
        }
        // Reply work precedes full metadata, preventing slow analytics from consuming the
        // whole budget before the inbox can make progress.
        if (currentCampaignSenders.size > 0 && !campaign.messages_purged_at && !emailBudgetExhausted) {
          const queued = await admin.from('outreach_fetch_queue').select('*').eq('campaign_id', campaign.id)
            .is('completed_at', null).lte('available_at', new Date().toISOString()).order('available_at').limit(1).maybeSingle()
          check(queued.error)
          const pollDue = !!state.reply_scan_started_at || syncDue(state.replies_synced_at, 2 * MINUTE, Date.now())
          if (queued.data && (!pollDue || state.last_email_kind === 'poll')) {
            try {
              result.messages += await refreshQueuePage(admin, campaign, queued.data, scope, { ...readOptions, beforeAttempt })
              await updateState(admin, state, { last_email_kind: 'queue' })
            } catch (error) {
              if (!(error instanceof Deferred)) {
                check((await admin.from('outreach_fetch_queue').update({
                  attempt_count: queued.data.attempt_count + 1, last_error: 'Sending engine fetch failed',
                  available_at: new Date(Date.now() + retryDelayMs(queued.data.attempt_count + 1)).toISOString(),
                }).eq('id', queued.data.id).eq('requested_at', queued.data.requested_at)).error)
              }
              throw error
            }
          } else if (pollDue) {
            result.messages += await refreshReplyPage(admin, campaign, state, scope, { ...readOptions, beforeAttempt })
          }
        }
        if (syncDue(state.meta_synced_at, 15 * MINUTE, Date.now())) {
          hasTime(); await refreshMetadata(admin, campaign, state, remote, readOptions)
        }
        if (syncDue(state.daily_synced_at, 30 * MINUTE, Date.now())) {
          hasTime(); await refreshAnalytics(admin, campaign, state, remote, readOptions)
        }
        if (state.lead_cursor || syncDue(state.leads_synced_at, 30 * MINUTE, Date.now())) {
          hasTime(); await refreshLeadPage(admin, campaign, state, readOptions)
        }
        await updateState(admin, state, { retry_after: null, attempt_count: 0, last_error: null })
        result.campaigns += 1
      } catch (error) {
        if (error instanceof Deferred || (error instanceof InstantlyError && error.status === 408)) {
          result.deferred += 1
          if (emailBudgetExhausted) {
            // Do not rotate an unserved campaign behind those that consumed
            // this minute's ten permits. It leads the next tick instead.
            await updateState(admin, state, { last_served_at: previouslyServedAt })
            break
          }
          continue
        }
        result.failed += 1
        await updateState(admin, state, { attempt_count: state.attempt_count + 1,
          retry_after: new Date(Date.now() + retryDelayMs(state.attempt_count + 1)).toISOString(),
          last_error: error instanceof InstantlyError ? `Sending engine request failed (${error.status})` : 'Outreach synchronization failed',
        })
      }
    }
    return { ...result, linkedin_senders: linkedin.senders, linkedin_conversations: linkedin.conversations }
  } finally {
    check((await admin.rpc('release_outreach_sync_lock', { p_token: token })).error)
  }
}
