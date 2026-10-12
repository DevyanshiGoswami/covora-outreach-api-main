import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { z } from 'zod'
import { createSupabaseAdminClient } from '../src/lib/supabase/admin'
import { databaseTargetAllowed } from '../src/lib/runtime-config'
import { campaignStatus } from '../src/lib/outreach-metrics'
import {
  getCampaign, getCampaignAnalytics, getDailyCampaignAnalytics, listCampaignLeadsPage,
  scopedCampaignSenders, verifyScopedInstantlyWorkspace, type InstantlyReadOptions,
} from '../src/lib/instantly'
import {
  count, leadForAssignment, neutralText, normalizedSchedule, normalizedStats,
  normalizedTotals, record, sequencePlainText,
} from '../src/lib/outreach-sync-data'

const PROJECT = 'uuqrewifuwscnyxepjbh'
const MAX_LEAD_PAGES = 1000
const MAX_DURATION_MS = 20 * 60_000
const manifestSchema = z.object({
  projectRef: z.literal(PROJECT), clientId: z.uuid(), remoteWorkspaceId: z.uuid(),
  campaignIds: z.array(z.uuid()).min(1).max(50),
  senderAddresses: z.array(z.string().trim().toLowerCase().pipe(z.email().max(254))).max(500),
}).strict()
type Manifest = z.infer<typeof manifestSchema>
type CampaignProgress = { campaignId: string; leadPages: number; leads: number; skippedLeads: number; dailyRows: number; steps: number }
type Progress = { mode: 'apply' | 'check'; campaigns: CampaignProgress[]; complete: boolean }

function requireResult<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw new Error('Backfill database operation failed')
  return result.data
}
function sameSet(actual: readonly string[], expected: readonly string[]) {
  return actual.length === expected.length && new Set(actual).size === actual.length
    && actual.every(value => expected.includes(value))
}

/** This operational importer has no message, sending, assignment or sync-state write path. */
export async function backfillAssignedCampaigns(rawManifest: unknown, options: {
  apply: boolean;
  onProgress?: (progress: CampaignProgress) => void;
  delay?: (milliseconds: number) => Promise<unknown>;
}): Promise<Progress> {
  const manifest: Manifest = manifestSchema.parse(rawManifest)
  if (!sameSet(manifest.campaignIds, [...new Set(manifest.campaignIds)])
    || !sameSet(manifest.senderAddresses, [...new Set(manifest.senderAddresses)])
    || process.env.OUTREACH_SUPABASE_PROJECT_REF !== PROJECT
    || !databaseTargetAllowed(process.env.NEXT_PUBLIC_SUPABASE_URL, PROJECT, true)) {
    throw new Error('Backfill target or manifest is invalid')
  }
  const db = createSupabaseAdminClient()
  const deadline = Date.now() + MAX_DURATION_MS
  const token = randomUUID()
  let held = false, leadPages = 0
  const progress: Progress = { mode: options.apply ? 'apply' : 'check', campaigns: [], complete: false }
  const timeCheck = () => { if (Date.now() >= deadline) throw new Error('Backfill time limit reached; rerun the manifest to continue safely') }

  const scope = async () => {
    timeCheck()
    const [featureResult, bindingResult, campaignResult] = await Promise.all([
      db.from('client_features').select('enabled,config').eq('client_id', manifest.clientId).eq('feature', 'outreach_app').maybeSingle(),
      db.from('outreach_reply_workspaces').select('id,remote_workspace_id,credential_ref,sync_enabled,version')
        .eq('client_id', manifest.clientId).eq('channel', 'email').maybeSingle(),
      db.from('outreach_campaigns').select('id,client_id,provider_campaign_id,completed_at,totals').eq('client_id', manifest.clientId)
        .eq('channel', 'email').order('id').limit(51),
    ])
    const feature = requireResult(featureResult), binding = requireResult(bindingResult), campaigns = requireResult(campaignResult)
    if (!feature?.enabled || record(feature.config).presentation_mode === 'preview'
      || !binding?.sync_enabled || binding.remote_workspace_id !== manifest.remoteWorkspaceId
      || !/^OUTREACH_INSTANTLY_[A-Z0-9_]{1,100}$/.test(binding.credential_ref)
      || !campaigns || !sameSet(campaigns.map(c => c.provider_campaign_id), manifest.campaignIds)) {
      throw new Error('Backfill assignment or workspace scope changed')
    }
    const senders = requireResult(await db.from('outreach_reply_senders').select('remote_sender_id,sender_address,version')
      .eq('client_id', manifest.clientId).eq('workspace_id', binding.id).eq('channel', 'email').order('remote_sender_id').limit(501))
    if (!senders || senders.some(s => s.remote_sender_id !== s.sender_address)
      || !sameSet(senders.map(s => s.sender_address), manifest.senderAddresses)) {
      throw new Error('Backfill sender scope changed')
    }
    const assignments = campaigns.map(({ id, client_id, provider_campaign_id }) => ({ id, client_id, provider_campaign_id }))
    return { campaigns, binding, stamp: JSON.stringify({ feature, binding, assignments, senders }) }
  }
  const initial = await scope()
  const apiKey = process.env[initial.binding.credential_ref]?.trim()
  if (!apiKey) throw new Error('Backfill dedicated credential is unavailable')

  const renew = async () => {
    timeCheck()
    if (!options.apply) return
    const acquired = requireResult(await db.rpc('acquire_outreach_sync_lock', { p_token: token, p_seconds: 300 }))
    if (!acquired) throw new Error('Another synchronization owns the lease; retry after it completes')
    held = true
  }
  const beforeWrite = async () => {
    await renew()
    const current = await scope()
    if (current.stamp !== initial.stamp || process.env[initial.binding.credential_ref]?.trim() !== apiKey) {
      throw new Error('Backfill authority changed; remaining writes were stopped')
    }
    return current
  }
  const providerOptions: InstantlyReadOptions = { apiKey, deadline, beforeAttempt: async () => {
    await renew()
    await (options.delay ?? wait)(1000)
    timeCheck()
  } }

  try {
    await renew()
    if (!await verifyScopedInstantlyWorkspace(manifest.remoteWorkspaceId, { apiKey, timeoutMs: 8000 })) {
      throw new Error('Backfill provider workspace did not match')
    }
    for (const campaign of initial.campaigns) {
      await beforeWrite()
      const remote = await getCampaign(campaign.provider_campaign_id, providerOptions)
      scopedCampaignSenders(remote, campaign.provider_campaign_id, manifest.remoteWorkspaceId, manifest.senderAddresses)
      if (!remote.name || !remote.timestamp_created || !Number.isFinite(Date.parse(remote.timestamp_created))) {
        throw new Error('Backfill campaign metadata is incomplete')
      }
      const totals = await getCampaignAnalytics(campaign.provider_campaign_id, providerOptions)
      if ((!totals && remote.status !== 0) || totals?.campaign_id && totals.campaign_id !== campaign.provider_campaign_id) {
        throw new Error('Backfill campaign analytics did not match')
      }
      const start = new Date(remote.timestamp_created).toISOString().slice(0, 10)
      const end = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
      const daily = await getDailyCampaignAnalytics(campaign.provider_campaign_id, start, end, providerOptions)
      if (!Array.isArray(daily) || daily.length > 10_000) throw new Error('Backfill daily history exceeds its limit')
      const days = daily.map(day => {
        if (typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(day.date) || !Number.isFinite(Date.parse(day.date))) {
          throw new Error('Backfill daily date is invalid')
        }
        const stats = normalizedStats(day)
        return { campaign_id: campaign.id, client_id: campaign.client_id, day: day.date.slice(0, 10), sent: stats.sent,
          contacted: stats.contacted, new_contacted: count(day.new_leads_contacted), unique_opened: stats.unique_opened,
          unique_replies: stats.unique_replies, auto_replies: stats.unique_auto_replies,
          unique_clicks: stats.unique_clicks, opportunities: stats.opportunities }
      })
      if (new Set(days.map(day => day.day)).size !== days.length) throw new Error('Backfill daily dates are duplicated')
      const rawSteps = remote.sequences?.[0]?.steps
      if (rawSteps !== undefined && (!Array.isArray(rawSteps) || rawSteps.length > 100)) throw new Error('Backfill sequence exceeds its limit')
      const steps = (rawSteps ?? []).flatMap((step, index) => {
        if (step.type !== 'email' || !Number.isFinite(step.delay) || step.delay < 0
          || step.delay_unit !== undefined && !['minutes', 'hours', 'days'].includes(step.delay_unit)
          || !Array.isArray(step.variants) || step.variants.length > 100) throw new Error('Backfill sequence is unsupported')
        const divisor = step.delay_unit === 'minutes' ? 1440 : step.delay_unit === 'hours' ? 24 : 1
        return step.variants.map((variant, variantIndex) => ({ campaign_id: campaign.id, client_id: campaign.client_id,
          step: index + 1, variant: variantIndex, subject: neutralText(variant.subject), body_text: sequencePlainText(variant.body), delay_days: step.delay / divisor }))
      })
      const current: CampaignProgress = { campaignId: campaign.id, leadPages: 0, leads: 0, skippedLeads: 0, dailyRows: days.length, steps: steps.length }
      if (options.apply) {
        for (let offset = 0; offset < days.length; offset += 500) {
          await beforeWrite()
          requireResult(await db.from('outreach_campaign_daily').upsert(days.slice(offset, offset + 500), { onConflict: 'campaign_id,day' }))
        }
        for (let offset = 0; offset < steps.length; offset += 500) {
          await beforeWrite()
          requireResult(await db.from('outreach_campaign_steps').upsert(steps.slice(offset, offset + 500), { onConflict: 'campaign_id,step,variant' }))
        }
      }
      const cursors = new Set<string>()
      let cursor: string | undefined
      while (true) {
        if (++leadPages > MAX_LEAD_PAGES) throw new Error('Backfill lead-page limit reached')
        const page = await listCampaignLeadsPage(campaign.provider_campaign_id, cursor, providerOptions)
        if (!Array.isArray(page.items) || page.items.length > 100
          || page.next_starting_after !== undefined && (typeof page.next_starting_after !== 'string' || page.next_starting_after.length > 2048)
          || page.items.some(lead => lead?.campaign !== undefined && lead.campaign !== campaign.provider_campaign_id)) {
          throw new Error('Backfill lead page has invalid campaign scope')
        }
        const next = page.next_starting_after || undefined
        if (next && (cursors.has(next) || page.items.length === 0)) throw new Error('Backfill lead pagination did not advance')
        const rows = page.items.map(lead => leadForAssignment(campaign, lead)).filter(lead => lead !== null)
        if (new Set(rows.map(row => row.email)).size !== rows.length) throw new Error('Backfill lead page contains duplicate identities')
        if (options.apply && rows.length) {
          await beforeWrite()
          requireResult(await db.from('outreach_leads').upsert(rows, { onConflict: 'campaign_id,email' }))
        }
        current.leadPages++; current.leads += rows.length; current.skippedLeads += page.items.length - rows.length
        if (!next) break
        cursors.add(next); cursor = next
      }
      if (options.apply) {
        const currentScope = await beforeWrite()
        const latestCampaign = currentScope.campaigns.find(item => item.id === campaign.id)!
        const positive = await db.from('outreach_leads').select('id', { head: true, count: 'exact' })
          .eq('client_id', manifest.clientId).eq('campaign_id', campaign.id).in('interest', ['Interested', 'Meeting booked', 'Won'])
        requireResult(positive)
        const now = new Date().toISOString()
        requireResult(await db.from('outreach_campaigns').update({ name: neutralText(remote.name).slice(0, 500) || 'Campaign',
          status: campaignStatus(remote.status), schedule: normalizedSchedule(remote.campaign_schedule),
          totals: { ...(totals ? normalizedTotals(totals) : record(latestCampaign.totals)),
            analytics_available: totals !== null, positive_replies: positive.count ?? 0 } as typeof campaign.totals, synced_at: now,
          completed_at: remote.status === 3 ? latestCampaign.completed_at ?? now : null,
        }).eq('id', campaign.id).eq('client_id', manifest.clientId).eq('provider_campaign_id', campaign.provider_campaign_id))
      }
      progress.campaigns.push(current)
      options.onProgress?.(current)
    }
    progress.complete = true
    return progress
  } finally {
    if (held) requireResult(await db.rpc('release_outreach_sync_lock', { p_token: token }))
  }
}

async function main() {
  const [manifestPath, mode, ...extra] = process.argv.slice(2)
  if (!manifestPath || !['--check', '--apply'].includes(mode) || extra.length) {
    throw new Error('Usage: backfill-assigned-campaigns.ts <manifest.json> --check|--apply')
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const result = await backfillAssignedCampaigns(manifest, { apply: mode === '--apply',
    onProgress: progress => process.stdout.write(JSON.stringify({ completedCampaign: progress }) + '\n') })
  process.stdout.write(JSON.stringify(result) + '\n')
}

if (basename(process.argv[1] ?? '') === 'backfill-assigned-campaigns.ts') {
  main().catch(error => {
    const reason = error instanceof Error && /^(?:Backfill |Another synchronization |Usage:)/.test(error.message)
      ? error.message : 'Review the target, manifest, scoped credential and provider health.'
    console.error(`Campaign backfill stopped. ${reason} Completed upserts are safe to repeat; no messages were accessed.`)
    process.exitCode = 1
  })
}
