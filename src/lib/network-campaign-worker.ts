import 'server-only'
import type { CronContext } from './cron-worker'
import { createSupabaseAdminClient } from './supabase/admin'
import { resolveIntegrationCredential } from './integration-credentials'
import { readNetworkCampaign, NetworkReadError, type NetworkScope, type NetworkObservation } from './network-campaign-provider'
import { retryDelayMs } from './outreach-sync-data'

type Binding = NetworkScope & { id: string; clientId: string; workspaceLocalId: string; workspaceVersion: number;
  senderLocalIds: string[]; senderVersions: number[]; credentialRef: string; attemptCount: number }
type Dependencies = {
  candidates: () => Promise<Binding[]>; timeLeft: () => number; markAttempt: (b: Binding) => Promise<void>;
  credential: (b: Binding) => Promise<string | undefined>; read: (b: Binding,key: string) => Promise<NetworkObservation>;
  save: (b: Binding,value: NetworkObservation) => Promise<boolean>; fail: (b: Binding,retryMs: number) => Promise<void>;
}
/** One campaign per tick, five-minute successful cadence, bounded retries under the shared lease. */
export async function runNetworkCampaignBatch(deps: Dependencies) {
  const result = { campaigns: 0, failed: 0, deferred: 0 }
  if (deps.timeLeft() < 7000) return { ...result, deferred: 1 }
  for (const b of (await deps.candidates()).slice(0,1)) {
    if (deps.timeLeft() < 7000) { result.deferred++; break }
    try {
      await deps.markAttempt(b)
      if (!/^OUTREACH_HEYREACH_[A-Z0-9_]{1,100}$/.test(b.credentialRef)) throw new NetworkReadError()
      const key = await deps.credential(b)
      if (!key) throw new NetworkReadError()
      if (deps.timeLeft() < 5000) { result.deferred++; break }
      const value = await deps.read(b,key)
      if (await deps.save(b,value)) result.campaigns++
      else result.deferred++ // Configuration changed while the provider request was in flight.
    } catch (error) {
      result.failed++
      await deps.fail(b,Math.max(retryDelayMs(b.attemptCount+1), error instanceof NetworkReadError ? error.retryAfterMs : 0))
    }
  }
  return result
}

export async function syncNetworkCampaigns(ctx: CronContext) {
  const db = createSupabaseAdminClient()
  const dbSignal = () => AbortSignal.timeout(Math.max(1,Math.min(2000,ctx.timeLeft()-1000)))
  const check = (error: unknown) => { if(error) throw new NetworkReadError() }
  return runNetworkCampaignBatch({
    timeLeft: ctx.timeLeft,
    candidates: async () => {
      const candidates = await db.rpc('next_outreach_network_campaign').abortSignal(AbortSignal.timeout(Math.max(1,Math.min(2000,ctx.timeLeft()-5000))))
      check(candidates.error)
      return (candidates.data ?? []).map(c => ({ id:c.id,clientId:c.client_id,campaignId:c.provider_campaign_id,
        workspaceId:c.remote_workspace_id,workspaceLocalId:c.workspace_id,workspaceVersion:c.workspace_version,
        credentialRef:c.credential_ref,senderIds:c.remote_sender_ids,senderLocalIds:c.sender_ids,
        senderVersions:c.sender_versions,attemptCount:c.attempt_count }))
    },
    credential:b=>resolveIntegrationCredential(b.credentialRef,process.env,db,dbSignal()),
    markAttempt:async b=>{check((await db.from('outreach_sync_state').update({last_served_at:new Date().toISOString()}).eq('campaign_id',b.id).eq('client_id',b.clientId).abortSignal(dbSignal())).error)},
    read:(b,apiKey)=>readNetworkCampaign(b,{apiKey,timeoutMs:Math.min(6500,Math.max(1,ctx.timeLeft()-5000))}),
    save:async(b,v)=>{
      const r=await db.rpc('save_outreach_network_campaign',{p_campaign_id:b.id,p_workspace_id:b.workspaceLocalId,p_workspace_version:b.workspaceVersion,
        p_sender_ids:b.senderLocalIds,p_sender_versions:b.senderVersions,p_name:v.name,p_status:v.status,p_totals:v.totals}).abortSignal(dbSignal())
      check(r.error); return r.data===true
    },
    fail:async(b,retryMs)=>{check((await db.from('outreach_sync_state').update({attempt_count:b.attemptCount+1,retry_after:new Date(Date.now()+retryMs).toISOString(),last_error:'Network campaign synchronization failed'})
      .eq('campaign_id',b.id).eq('client_id',b.clientId).abortSignal(dbSignal())).error)},
  })
}
