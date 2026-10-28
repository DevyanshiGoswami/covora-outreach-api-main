import 'server-only'
import { z } from 'zod'
import { neutralText } from './outreach-sync-data'
import type { ScopedReplyOptions } from './outreach-reply-types'

const BASE = 'https://api.heyreach.io/api/public'
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional()
const metadata = z.object({ id, organizationUnitId: id, name: z.string().min(1).max(2000), status: z.string(),
  creationTime: z.string().refine(v => Number.isFinite(Date.parse(v))), campaignAccountIds: z.array(id).min(1).max(100),
  progressStats: z.object({ totalUsers: count }).optional() })
const stats = z.object({ overallStats: z.array(z.object({ campaignId: id, isCampaignDeleted: z.boolean(),
  connectionsSent: count, connectionsAccepted: count, messagesSent: count, totalMessageReplies: count })).max(1) })
export type NetworkScope = { campaignId: string; workspaceId: string; senderIds: readonly string[] }
export type NetworkObservation = { name: string; status: string; totals: {
  leads: number | null; invitations_sent: number | null; invitations_accepted: number | null; messages_sent: number | null; replies: number | null
} }
export class NetworkReadError extends Error {
  constructor(public retryAfterMs = 0) { super('Network campaign read unavailable') }
}
function numericId(v: string) { return /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v)) }
function status(v: string) { return ({ DRAFT: 'draft', IN_PROGRESS: 'active', PAUSED: 'paused', FINISHED: 'completed', COMPLETED: 'completed', STOPPED: 'stopped', CANCELED: 'stopped' } as Record<string,string>)[v] ?? 'unknown' }
/** Two read-only requests, explicit nonempty campaign+sender filters, no outbound actions. */
export async function readNetworkCampaign(scope: NetworkScope, options: ScopedReplyOptions, now = new Date()): Promise<NetworkObservation> {
  if (!numericId(scope.campaignId) || !numericId(scope.workspaceId) || scope.senderIds.length < 1 || scope.senderIds.length > 100
    || scope.senderIds.some(v => !numericId(v)) || new Set(scope.senderIds).size !== scope.senderIds.length) throw new NetworkReadError()
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 6500, 10000)))
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  async function read(path: string, body?: unknown) {
    const response = await (options.fetch ?? fetch)(BASE + path, { method: body ? 'POST' : 'GET',
      headers: { 'X-API-KEY': options.apiKey, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
      signal, redirect: 'error', cache: 'no-store' })
    if (!response.ok) {
      const h = response.headers.get('Retry-After')
      const retry = h ? (/^\d+$/.test(h) ? Number(h)*1000 : Date.parse(h)-now.getTime()) : 0
      throw new NetworkReadError(Number.isFinite(retry) ? Math.min(86400000, Math.max(0,retry)) : 0)
    }
    return response.json()
  }
  try {
    const campaign = metadata.parse(await read(`/campaign/GetById?campaignId=${scope.campaignId}`))
    if (String(campaign.id) !== scope.campaignId || String(campaign.organizationUnitId) !== scope.workspaceId
      || new Set(campaign.campaignAccountIds).size !== campaign.campaignAccountIds.length
      || campaign.campaignAccountIds.some(sender => !scope.senderIds.includes(String(sender)))
      || Date.parse(campaign.creationTime)>now.getTime()) throw new NetworkReadError()
    const report = stats.parse(await read('/stats/GetOverallStatsByCampaign', { campaignIds: [campaign.id], accountIds: campaign.campaignAccountIds,
      startDate: new Date(campaign.creationTime).toISOString(), endDate: now.toISOString() }))
    if (report.overallStats.some(row => row.campaignId !== campaign.id || row.isCampaignDeleted)) throw new NetworkReadError()
    const row = report.overallStats[0]
    return { name: neutralText(campaign.name).replace(/heyreach/gi,'delivery service').slice(0,500) || 'Campaign', status: status(campaign.status), totals: {
      leads: campaign.progressStats?.totalUsers ?? null, invitations_sent: row?.connectionsSent ?? null,
      invitations_accepted: row?.connectionsAccepted ?? null, messages_sent: row?.messagesSent ?? null, replies: row?.totalMessageReplies ?? null,
    } }
  } catch (error) { if (error instanceof NetworkReadError) throw error; throw new NetworkReadError() }
}
