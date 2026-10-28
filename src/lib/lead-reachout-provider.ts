import 'server-only'
import { z } from 'zod'
import { verifyScopedInstantlyAccount } from './instantly'
import { reachoutLog, providerValidationFields } from './reachout-log'

export type ReachoutCommand = { id: string; channel: 'linkedin' | 'email'; recipient: string; recipientName: string; subject: string; body: string }
export type ReachoutBinding = { remoteSender: string; workspace: string }
type Options = { key: string; fetch?: typeof fetch; checkpoint: (campaign: string, list?: string) => Promise<void>; authorize: () => Promise<void> }
export class ReachoutFailure extends Error {
  constructor(readonly code: 'account_unavailable' | 'already_connected' | 'provider_rejected' | 'outcome_unknown', readonly uncertain = false) { super(code) }
}
const numberId = z.number().int().positive().safe()
const profile = (s: string) => s.toLowerCase().replace(/\/$/, '')
const html = (s: string) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;').replaceAll('\n','<br/>')

function transport(channel: 'linkedin' | 'email', options: Pick<Options,'key'|'fetch'>) {
  return async (path: string, body?: unknown, mutation = false): Promise<unknown> => {
    let response: Response
    const started=Date.now()
    try {
      response = await (options.fetch ?? fetch)(`${channel === 'linkedin' ? 'https://api.heyreach.io/api/public' : 'https://api.instantly.ai/api/v2'}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(channel === 'linkedin' ? { 'X-API-KEY': options.key } : { Authorization: `Bearer ${options.key}` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12000),
      })
    } catch {
      reachoutLog('delivery.transport_failed',{channel,operation:path,status:null,durationMs:Date.now()-started})
      throw new ReachoutFailure(mutation ? 'outcome_unknown' : 'account_unavailable', mutation)
    }
    reachoutLog(response.ok?'delivery.completed':'delivery.rejected',{channel,operation:path,status:response.status,durationMs:Date.now()-started,fields:response.ok?[]:await providerValidationFields(response)})
    if (!response.ok) throw new ReachoutFailure(response.status >= 500 && mutation ? 'outcome_unknown' : 'provider_rejected', mutation && response.status >= 500)
    try {
      const raw = await response.text()
      if (raw.length > 2_000_000) throw new Error()
      return raw ? JSON.parse(raw) : null
    } catch { throw new ReachoutFailure(mutation ? 'outcome_unknown' : 'account_unavailable', mutation) }
  }
}

/** One recipient, one step, one sender. No automatic replay of any mutation. */
export async function dispatchReachout(command: ReachoutCommand, binding: ReachoutBinding, options: Options) {
  const request = transport(command.channel, options)
  let mutationStarted = false
  try {
    if (command.channel === 'linkedin') {
      const sender = numberId.parse(Number(binding.remoteSender))
      const account = z.object({ id: numberId, authIsValid: z.boolean(), profileUrl: z.string().optional() })
        .parse(await request(`/li_account/GetById?accountId=${sender}`))
      if (account.id !== sender || !account.authIsValid || account.profileUrl && profile(account.profileUrl) === profile(command.recipient)) throw new ReachoutFailure('account_unavailable')
      const relationship = z.object({ isConnection: z.boolean() }).parse(await request('/MyNetwork/IsConnection', { senderAccountId: sender, leadProfileUrl: command.recipient }))
      if (relationship.isConnection) throw new ReachoutFailure('already_connected')
      await options.authorize()
      mutationStarted = true
      const list = z.object({ id: numberId }).parse(await request('/list/CreateEmptyList', { name: `Covora ${command.id}`, type: 'USER_LIST' }, true))
      const [firstName = '', ...lastName] = command.recipientName.trim().split(/\s+/)
      const added = z.object({ addedLeadsCount: z.number().int().nonnegative(), updatedLeadsCount: z.number().int().nonnegative(), failedLeadsCount: z.number().int().nonnegative() })
        .parse(await request('/list/AddLeadsToListV2', { listId: list.id, leads: [{
          profileUrl: command.recipient, firstName, lastName: lastName.join(' '),
          location: '', summary: '', companyName: '', position: '', about: '', emailAddress: '', customUserFields: [],
        }] }, true))
      if (added.failedLeadsCount !== 0 || added.addedLeadsCount + added.updatedLeadsCount !== 1) {reachoutLog('recipient.import_failed',{channel:command.channel,count:added.failedLeadsCount});throw new ReachoutFailure('provider_rejected')}
      const imported = z.object({ totalCount: z.number().int(), items: z.array(z.object({ profileUrl: z.string() })) })
        .parse(await request('/list/GetLeadsFromList', { listId: list.id, offset: 0, limit: 2, keyword: '' }))
      if (imported.totalCount !== 1 || imported.items.length !== 1 || profile(imported.items[0].profileUrl) !== profile(command.recipient)) {reachoutLog('recipient.verification_failed',{channel:command.channel,count:imported.totalCount});throw new ReachoutFailure('provider_rejected')}
      const end = { nodeType: 'END', actionDelay: 3, actionDelayUnit: 'HOUR' }
      const campaign = z.object({ campaignId: numberId }).parse(await request('/campaign/Create', {
        name: `Covora ${command.id}`, linkedInUserListId: list.id, linkedInAccountIds: [sender],
        schedule: { dailyStartTime: '00:00:00', dailyEndTime: '23:59:00', timeZoneId: 'Etc/UTC', enabledMonday: true, enabledTuesday: true, enabledWednesday: true, enabledThursday: true, enabledFriday: true, enabledSaturday: true, enabledSunday: true },
        excludeContactedFromOtherCampaigns: true, excludeHasOtherAccConversations: true, excludeContactedFromSenderInOtherCampaign: true,
        sequence: { nodeType: 'CONNECTION_REQUEST', actionDelay: 0, actionDelayUnit: 'DAY',
          payload: { messages: command.body ? [command.body] : [], fallbackMessage: command.body, toBeWithdrawnAfterDays: 30 },
          conditionalNode: end, unconditionalNode: end },
      }, true))
      await options.checkpoint(String(campaign.campaignId), String(list.id))
      await options.authorize()
      await request(`/campaign/StartCampaign?campaignId=${campaign.campaignId}`, {}, true)
      return { status: 'queued' as const, campaignId: String(campaign.campaignId) }
    }
    const account = await verifyScopedInstantlyAccount(binding.remoteSender, { apiKey: options.key, expectedWorkspaceId: binding.workspace, fetch: options.fetch })
    if (account.state !== 'connected') throw new ReachoutFailure('account_unavailable')
    await options.authorize()
    mutationStarted = true
    const campaign = z.object({ id: z.uuid() }).parse(await request('/campaigns', {
      name: `Covora ${command.id}`, email_list: [binding.remoteSender],
      campaign_schedule: { schedules: [{ name: 'Requested outreach', timezone: 'Africa/Abidjan', timing: { from: '00:00', to: '23:59' }, days: { '0': true, '1': true, '2': true, '3': true, '4': true, '5': true, '6': true } }] },
      sequences: [{ steps: [{ type: 'email', delay: 0, variants: [{ subject: command.subject, body: html(command.body) }] }] }],
      daily_limit: 1, daily_max_leads: 1, stop_on_reply: true, stop_on_auto_reply: true, open_tracking: false, link_tracking: false,
      text_only: true, allow_risky_contacts: false, disable_bounce_protect: false,
    }, true))
    await options.checkpoint(campaign.id)
    const lead = z.object({ id: z.uuid(), email: z.string(), campaign: z.string() }).parse(await request('/leads', {
      campaign: campaign.id, email: command.recipient, skip_if_in_campaign: true, skip_if_in_workspace: true,
    }, true))
    if (lead.campaign !== campaign.id || lead.email.toLowerCase() !== command.recipient.toLowerCase()) throw new ReachoutFailure('provider_rejected')
    await options.authorize()
    await request(`/campaigns/${campaign.id}/activate`, {}, true)
    return { status: 'queued' as const, campaignId: campaign.id }
  } catch (error) {
    if (error instanceof ReachoutFailure) throw error
    // A malformed successful mutation or failed checkpoint may already have created a remote resource.
    throw new ReachoutFailure(mutationStarted ? 'outcome_unknown' : 'account_unavailable', mutationStarted)
  }
}

/** Status reflects explicit per-lead evidence, never campaign completion alone. */
export async function observeReachout(command: ReachoutCommand, binding: ReachoutBinding, campaignId: string, options: Pick<Options,'key'|'fetch'>): Promise<'queued'|'sent'|'connected'|'replied'|'failed'|null> {
  const request = transport(command.channel, options)
  if (command.channel === 'linkedin') {
    const campaign = numberId.parse(Number(campaignId))
    const metadata = z.object({ id: numberId, organizationUnitId: numberId, campaignAccountIds: z.array(numberId) }).parse(await request(`/campaign/GetById?campaignId=${campaign}`))
    if (metadata.id !== campaign || String(metadata.organizationUnitId) !== binding.workspace || metadata.campaignAccountIds.length !== 1 || String(metadata.campaignAccountIds[0]) !== binding.remoteSender) throw new ReachoutFailure('account_unavailable')
    const result = z.object({ totalCount: z.number(), items: z.array(z.object({ linkedInUserProfile: z.object({ profileUrl: z.string() }), linkedInSenderId: numberId.nullish(), leadConnectionStatus: z.string(), leadMessageStatus: z.string(), leadCampaignStatus: z.string() })) })
      .parse(await request('/campaign/GetLeadsFromCampaign', { campaignId: campaign, offset: 0, limit: 100, timeFilter: 'Everywhere' }))
    if (result.totalCount > 1 || result.items.length > 1) throw new ReachoutFailure('account_unavailable')
    const item = result.items[0]
    if (!item) return null
    if (profile(item.linkedInUserProfile.profileUrl) !== profile(command.recipient) || item.linkedInSenderId && String(item.linkedInSenderId) !== binding.remoteSender) throw new ReachoutFailure('account_unavailable')
    if (item.leadMessageStatus === 'MessageReply') return 'replied'
    if (item.leadConnectionStatus === 'ConnectionAccepted') return 'connected'
    if (item.leadConnectionStatus === 'ConnectionSent') return 'sent'
    if (item.leadCampaignStatus === 'Failed') return 'failed'
    return null
  }
  const campaign = z.uuid().parse(campaignId)
  const emails = z.object({ items: z.array(z.object({ campaign_id: z.string().nullable(), eaccount: z.string(), lead: z.string().nullable(), ue_type: z.number().nullable() })) })
    .parse(await request(`/emails?campaign_id=${campaign}&eaccount=${encodeURIComponent(binding.remoteSender)}&lead=${encodeURIComponent(command.recipient)}&limit=100`))
  const matching = emails.items.filter(item => item.campaign_id === campaign && item.eaccount.toLowerCase() === binding.remoteSender.toLowerCase() && item.lead?.toLowerCase() === command.recipient.toLowerCase())
  if (matching.some(item => item.ue_type === 2)) return 'replied'
  if (matching.some(item => item.ue_type === 1 || item.ue_type === 3)) return 'sent'
  return null
}
