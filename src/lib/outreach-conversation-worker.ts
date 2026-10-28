import { resolveIntegrationCredential } from './integration-credentials'
import 'server-only'
import { createSupabaseAdminClient } from './supabase/admin'
import { runtimeConfiguration } from './runtime-config'
import type { CronContext } from './cron-worker'
import { syncLinkedinConversationPage, type ConversationSyncSender } from './outreach-conversation-sync'

export type ConversationSyncBinding = ConversationSyncSender & {
  clientId: string; workspaceId: string; workspaceVersion: number; version: number; credentialRef: string; cursor: string | null
}
type SyncDependencies = {
  candidates: () => Promise<ConversationSyncBinding[]>
  enabled: (binding: ConversationSyncBinding) => Promise<boolean>
  markAttempt: (binding: ConversationSyncBinding) => Promise<void>
  sync: (binding: ConversationSyncBinding, apiKey: string) => Promise<{ synced: number; nextCursor: string | null }>
  checkpoint: (binding: ConversationSyncBinding, cursor: string | null) => Promise<void>
  credentials: Readonly<Record<string, string | undefined>>
  timeLeft: () => number
}

/** Runs inside the existing outreach lease. A failed sender still rotates behind others. */
export async function runLinkedinConversationBatch(deps: SyncDependencies) {
  const result = { senders: 0, conversations: 0, failed: 0, deferred: 0 }
  for (const binding of (await deps.candidates()).slice(0, 3)) {
    if (deps.timeLeft() < 7000) { result.deferred++; break }
    try {
      await deps.markAttempt(binding)
      if (!await deps.enabled(binding)) continue
      if (!binding.campaigns.length) continue
      const key = /^OUTREACH_HEYREACH_[A-Z0-9_]{1,100}$/.test(binding.credentialRef) ? await resolveIntegrationCredential(binding.credentialRef, deps.credentials) : null
      if (!key) { result.failed++; continue }
      const page = await deps.sync(binding, key)
      await deps.checkpoint(binding, page.nextCursor)
      result.senders++; result.conversations += page.synced
    } catch { result.failed++ }
  }
  return result
}

/** Read-only at the delivery service; writes only the tenant's neutral local mirror. */
export async function syncLinkedinConversations(ctx: CronContext) {
  // Reserve most of the existing tick for email. Across ticks, least-recently
  // visited ordering prevents one large or broken LinkedIn account starving others.
  const deadline = Math.min(ctx.deadline - 5000, Date.now() + 14000)
  if (!runtimeConfiguration().syncEnabled) return { senders: 0, conversations: 0, failed: 0, deferred: 0, disabled: true }
  const db = createSupabaseAdminClient((input, init) => fetch(input, { ...init, signal: AbortSignal.any([init!.signal!, AbortSignal.timeout(Math.max(1, Math.min(4000, deadline - Date.now())))]) }))
  function check(error: unknown) { if (error) throw new Error('Conversation mirror unavailable') }
  return runLinkedinConversationBatch({
    credentials: process.env, timeLeft: () => deadline - Date.now(),
    candidates: async () => {
      const response = await db.from('outreach_reply_senders')
        .select('*, outreach_reply_workspaces!inner(id,version,credential_ref,sync_enabled)')
        .eq('channel', 'linkedin').eq('outreach_reply_workspaces.sync_enabled', true)
        .order('sync_started_at', { ascending: true, nullsFirst: true }).order('id').limit(3)
      check(response.error)
      return await Promise.all((response.data ?? []).map(async sender => {
        const campaigns = await db.from('outreach_campaigns').select('id,provider_campaign_id')
          .eq('client_id', sender.client_id).eq('channel', 'linkedin').is('messages_purged_at', null).order('id').limit(101)
        check(campaigns.error)
        if ((campaigns.data?.length ?? 0) > 100) throw new Error('Conversation campaign scope unavailable')
        return {
          id: sender.id, clientId: sender.client_id, workspaceId: sender.workspace_id, workspaceVersion: sender.outreach_reply_workspaces.version,
          version: sender.version, credentialRef: sender.outreach_reply_workspaces.credential_ref,
          remoteSenderId: sender.remote_sender_id, senderAddress: sender.sender_address, senderLabel: sender.sender_label, cursor: sender.sync_cursor,
          campaigns: (campaigns.data ?? []).map(campaign => ({ id: campaign.id, remoteCampaignId: campaign.provider_campaign_id })),
        }
      }))
    },
    enabled: async binding => {
      const feature = await db.from('client_features').select('enabled').eq('client_id', binding.clientId).eq('feature', 'outreach_app').maybeSingle()
      check(feature.error)
      const workspace = await db.from('outreach_reply_workspaces').select('id').eq('id', binding.workspaceId).eq('version', binding.workspaceVersion).eq('sync_enabled', true).maybeSingle()
      check(workspace.error)
      return feature.data?.enabled === true && Boolean(workspace.data)
    },
    markAttempt: async binding => {
      const response = await db.from('outreach_reply_senders').update({ sync_started_at: new Date().toISOString() }).eq('id', binding.id).eq('version', binding.version)
      check(response.error)
    },
    sync: (binding, apiKey) => syncLinkedinConversationPage(binding, binding.cursor, { apiKey, timeoutMs: 6000 }, async input => {
      if (Date.now() >= deadline) throw new Error('Conversation sync deadline reached')
      const response = await db.rpc('sync_outreach_linkedin_conversation', {
        p_sender_id: input.senderId, p_remote_conversation_id: input.remoteConversationId, p_contact_name: input.contactName,
        p_contact_address: input.contactAddress, p_subject: input.subject, p_messages: input.messages,
        p_campaign_id: input.campaignId, p_remote_campaign_id: input.remoteCampaignId,
        p_sender_version: binding.version, p_workspace_version: binding.workspaceVersion,
      })
      check(response.error)
    }),
    checkpoint: async (binding, cursor) => {
      const response = await db.from('outreach_reply_senders').update({ sync_cursor: cursor, ...(cursor === null ? { synced_at: new Date().toISOString() } : {}) })
        .eq('id', binding.id).eq('version', binding.version).select('id').maybeSingle()
      check(response.error)
      if (!response.data) throw new Error('Conversation binding changed')
    },
  })
}
