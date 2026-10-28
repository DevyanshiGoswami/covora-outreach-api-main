import 'server-only'
import { z } from 'zod'
import { resolveIntegrationCredential } from './integration-credentials'
import { instantlyMode, instantlyTransport } from './instantly-transport'

/** Starts one portal outreach: a single-sender, single-lead campaign in the shared
 * workspace. Every write is attempted once; an ambiguous response is 'unknown' and
 * is never retried. Live sends require explicit sender and recipient allowlists. */
const BASE_URL = 'https://api.instantly.ai/api/v2'
type Environment = Readonly<Record<string, string | undefined>>

export type PortalOutreachContext = {
  credentialRef: string; remoteWorkspaceId: string; senderAddress: string; recipientEmail: string
  recipientFirstName: string; recipientLastName: string; recipientCompany: string
  subject: string; bodyText: string; campaignName: string
}
export type PortalOutreachErrorCode = 'prepare_unavailable' | 'prepare_identity_mismatch' | 'dispatch_rejected' | 'dispatch_unknown'
export type PortalOutreachOutcome = {
  status: 'scheduled' | 'failed' | 'unknown'
  providerCampaignId: string | null
  providerLeadId: string | null
  errorCode: PortalOutreachErrorCode | null
}
export type PortalOutreachOptions = {
  credentials?: Environment
  env?: Environment
  fetch?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}

const address = z.string().trim().toLowerCase().pipe(z.email().max(254))
const accountSchema = z.object({ email: address, organization: z.uuid(), status: z.number(), setup_pending: z.boolean() })
const campaignSchema = z.object({ id: z.uuid(), email_list: z.array(address).optional() })
const leadSchema = z.object({ id: z.uuid(), email: address.optional() })

function list(value: string | undefined): ReadonlySet<string> {
  return new Set((value ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean))
}

/** Sending is closed unless explicitly enabled; live mode also needs both allowlists. */
export function portalOutreachAllowed(context: Pick<PortalOutreachContext, 'senderAddress' | 'recipientEmail'>, env: Environment = process.env): boolean {
  if (env.OUTREACH_PORTAL_SEND_ENABLED !== 'true') return false
  let mode
  try { mode = instantlyMode(env) } catch { return false }
  if (mode === 'mock') return true
  const senders = list(env.OUTREACH_PORTAL_ALLOWED_SENDERS), recipients = list(env.OUTREACH_PORTAL_ALLOWED_RECIPIENTS)
  return senders.has(context.senderAddress.trim().toLowerCase()) && recipients.has(context.recipientEmail.trim().toLowerCase())
}

export function portalOutreachEnabled(env: Environment = process.env): boolean {
  return env.OUTREACH_PORTAL_SEND_ENABLED === 'true'
}

function campaignBody(context: PortalOutreachContext) {
  const html = context.bodyText.split(/\r?\n/).map(line => line.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)).join('<br>')
  return {
    name: context.campaignName,
    // Sends as soon as the account's own limits allow; the schedule only bounds the window.
    campaign_schedule: { schedules: [{ name: 'Covora outreach', timing: { from: '00:00', to: '23:59' },
      days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: 'America/Chicago' }] },
    sequences: [{ steps: [{ type: 'email', delay: 0, variants: [{ subject: context.subject, body: html }] }] }],
    email_list: [context.senderAddress],
    daily_limit: 5,
    stop_on_reply: true,
    link_tracking: false,
    open_tracking: false,
  }
}

export async function startPortalOutreach(context: PortalOutreachContext, options: PortalOutreachOptions = {}): Promise<PortalOutreachOutcome> {
  const outcome = (status: PortalOutreachOutcome['status'], errorCode: PortalOutreachErrorCode | null, providerCampaignId: string | null = null, providerLeadId: string | null = null) =>
    ({ status, errorCode, providerCampaignId, providerLeadId })
  const env = options.env ?? process.env
  const sender = address.safeParse(context.senderAddress), recipient = address.safeParse(context.recipientEmail)
  if (!sender.success || !recipient.success || !z.uuid().safeParse(context.remoteWorkspaceId).success
    || !portalOutreachAllowed({ senderAddress: sender.data, recipientEmail: recipient.data }, env)
    || !/^OUTREACH_INSTANTLY_[A-Z0-9_]{1,100}$/.test(context.credentialRef)) return outcome('failed', 'prepare_unavailable')
  const apiKey = await resolveIntegrationCredential(context.credentialRef, options.credentials ?? process.env)
  if (!apiKey) return outcome('failed', 'prepare_unavailable')
  let transport: typeof fetch
  try { transport = options.fetch ?? instantlyTransport(env) } catch { return outcome('failed', 'prepare_unavailable') }
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 10_000, 12_000)))
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  const call = (path: string, body?: unknown) => transport(`${BASE_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', redirect: 'error', signal,
  })

  // Reads only: workspace and sender account must match before any write.
  try {
    const workspace = await call('/workspaces/current')
    if (!workspace.ok) return outcome('failed', 'prepare_unavailable')
    const current = z.object({ id: z.uuid() }).safeParse(await workspace.json())
    if (!current.success || current.data.id !== context.remoteWorkspaceId) return outcome('failed', 'prepare_identity_mismatch')
    const account = await call(`/accounts/${encodeURIComponent(sender.data)}`)
    if (account.status === 404) return outcome('failed', 'prepare_identity_mismatch')
    if (!account.ok) return outcome('failed', 'prepare_unavailable')
    const mailbox = accountSchema.safeParse(await account.json())
    if (!mailbox.success || mailbox.data.email !== sender.data || mailbox.data.organization !== context.remoteWorkspaceId) return outcome('failed', 'prepare_identity_mismatch')
    if (mailbox.data.status !== 1 || mailbox.data.setup_pending) return outcome('failed', 'prepare_unavailable')
  } catch { return outcome('failed', 'prepare_unavailable') }

  const write = async <T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<{ kind: 'ok'; value: T } | { kind: 'rejected' | 'unknown' }> => {
    let response: Response
    try { response = await call(path, body) } catch { return { kind: 'unknown' } }
    if (response.status >= 400 && response.status < 500) return { kind: 'rejected' }
    if (!response.ok) return { kind: 'unknown' }
    const parsed = schema.safeParse(await response.json().catch(() => null))
    return parsed.success ? { kind: 'ok', value: parsed.data } : { kind: 'unknown' }
  }

  const campaign = await write('/campaigns', campaignBody({ ...context, senderAddress: sender.data }), campaignSchema)
  if (campaign.kind !== 'ok') return campaign.kind === 'rejected' ? outcome('failed', 'dispatch_rejected') : outcome('unknown', 'dispatch_unknown')
  if (campaign.value.email_list && (campaign.value.email_list.length !== 1 || campaign.value.email_list[0] !== sender.data)) {
    // Recorded so the draft is visible; it is never activated.
    return outcome('failed', 'prepare_identity_mismatch', campaign.value.id)
  }
  const campaignId = campaign.value.id
  const lead = await write('/leads', { campaign: campaignId, email: recipient.data, first_name: context.recipientFirstName,
    last_name: context.recipientLastName, company_name: context.recipientCompany }, leadSchema)
  if (lead.kind !== 'ok') return lead.kind === 'rejected' ? outcome('failed', 'dispatch_rejected', campaignId) : outcome('unknown', 'dispatch_unknown', campaignId)
  if (lead.value.email && lead.value.email !== recipient.data) return outcome('failed', 'prepare_identity_mismatch', campaignId)
  const activated = await write(`/campaigns/${encodeURIComponent(campaignId)}/activate`, {}, z.unknown())
  if (activated.kind === 'rejected') return outcome('failed', 'dispatch_rejected', campaignId, lead.value.id)
  if (activated.kind === 'unknown') return outcome('unknown', 'dispatch_unknown', campaignId, lead.value.id)
  return outcome('scheduled', null, campaignId, lead.value.id)
}
