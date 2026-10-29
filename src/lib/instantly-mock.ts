import 'server-only'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Development-only simulation of the Instantly API v2 endpoints this product uses.
 * State lives in a local JSON file shared with scripts/mock-instantly.mjs. Nothing
 * here opens a socket, and supplied credentials are only checked for presence. */
export const MOCK_WORKSPACE_ID = '0c0ffee0-0000-4000-8000-000000000001'
const ORIGIN = 'https://api.instantly.ai'
const PREFIX = '/api/v2'

export type MockEmail = {
  id: string; organization_id: string; timestamp_created: string; timestamp_email: string
  subject: string; from_address_email: string; to_address_email_list: string; body: { text: string }
  campaign_id: string | null; lead: string; lead_id: string | null; eaccount: string
  ue_type: 1 | 2 | 3; thread_id: string; is_auto_reply: 0 | 1; i_status: number | null; is_unread: 0 | 1
}
type MockCampaign = {
  id: string; name: string; status: number; organization: string; email_list: string[]; email_tag_list: string[]
  sequences: Array<{ steps: Array<{ type: 'email'; delay: number; variants: Array<{ subject: string; body: string }> }> }>
  campaign_schedule: unknown; timestamp_created: string; timestamp_updated: string
}
type MockLead = { id: string; email: string; campaign: string; first_name: string; last_name: string; company_name: string; status: number; timestamp_created: string }
export type MockState = { version: 1; workspaceId: string; accounts: string[]; campaigns: Record<string, MockCampaign>; leads: Record<string, MockLead>; emails: MockEmail[] }

export function mockStatePath(env: Readonly<Record<string, string | undefined>> = process.env) {
  return path.resolve(env.OUTREACH_INSTANTLY_MOCK_STATE?.trim() || '.mock-instantly.json')
}

export function readMockState(file = mockStatePath()): MockState {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as MockState
    if (state?.version === 1 && Array.isArray(state.emails)) return state
  } catch { /* first use */ }
  return { version: 1, workspaceId: MOCK_WORKSPACE_ID, accounts: [], campaigns: {}, leads: {}, emails: [] }
}

export function writeMockState(state: MockState, file = mockStatePath()) {
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n')
  renameSync(temporary, file)
}

const reply = (body: unknown, status = 200) => Response.json(body, { status })
const missing = () => reply({ message: 'Not found' }, 404)
const lower = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : ''

function sendFirstStep(state: MockState, campaign: MockCampaign) {
  const step = campaign.sequences[0]?.steps[0]?.variants[0]
  const sender = campaign.email_list[0]
  if (!step || !sender) return
  for (const lead of Object.values(state.leads).filter(item => item.campaign === campaign.id)) {
    if (state.emails.some(email => email.campaign_id === campaign.id && email.lead === lead.email)) continue
    const now = new Date().toISOString()
    state.emails.push({
      id: randomUUID(), organization_id: state.workspaceId, timestamp_created: now, timestamp_email: now,
      subject: step.subject, from_address_email: sender, to_address_email_list: lead.email, body: { text: step.body },
      campaign_id: campaign.id, lead: lead.email, lead_id: lead.id, eaccount: sender, ue_type: 1, thread_id: randomUUID(),
      is_auto_reply: 0, i_status: null, is_unread: 0,
    })
    lead.status = 1
  }
}

function listEmails(state: MockState, query: URLSearchParams) {
  const type = query.get('email_type')
  const thread = query.get('search')?.match(/^thread:(.+)$/)?.[1]
  const min = query.get('min_timestamp_created'), max = query.get('max_timestamp_created')
  let items = state.emails.filter(email =>
    (!query.get('campaign_id') || email.campaign_id === query.get('campaign_id'))
    && (!type || email.ue_type === ({ sent: 1, received: 2, manual: 3 } as Record<string, number>)[type])
    && (!query.get('lead') || email.lead === lower(query.get('lead')))
    && (!query.get('eaccount') || email.eaccount === lower(query.get('eaccount')))
    && (!thread || email.thread_id === thread)
    && (!min || email.timestamp_created >= min) && (!max || email.timestamp_created <= max))
  items.sort((a, b) => b.timestamp_created.localeCompare(a.timestamp_created) || b.id.localeCompare(a.id))
  if (query.get('latest_of_thread') === 'true') {
    const seen = new Set<string>()
    items = items.filter(email => !seen.has(email.thread_id) && seen.add(email.thread_id))
  }
  const after = query.get('starting_after')
  const start = after ? items.findIndex(email => email.id === after) + 1 : 0
  const limit = Math.min(Math.max(Number(query.get('limit') ?? 100) || 100, 1), 100)
  const page = items.slice(start, start + limit)
  return { items: page, ...(start + limit < items.length && page.length ? { next_starting_after: page.at(-1)!.id } : {}) }
}

export const mockInstantlyFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin !== ORIGIN || !url.pathname.startsWith(PREFIX)) throw new TypeError('Mock sending engine refuses non-provider URLs')
  if (!/^Bearer\s+\S+/.test(request.headers.get('authorization') ?? '')) return reply({ message: 'Unauthorized' }, 401)
  const route = url.pathname.slice(PREFIX.length)
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) as Record<string, unknown> : {}
  const state = readMockState()
  const now = new Date().toISOString()
  let match: RegExpMatchArray | null

  if (request.method === 'GET' && route === '/workspaces/current') return reply({ id: state.workspaceId, name: 'Mock workspace' })
  if (request.method === 'GET' && (match = route.match(/^\/accounts\/([^/]+)$/))) {
    const email = lower(decodeURIComponent(match[1]))
    return state.accounts.includes(email) ? reply({ email, organization: state.workspaceId, status: 1, setup_pending: false }) : missing()
  }
  if (request.method === 'POST' && route === '/campaigns') {
    const senders = Array.isArray(body.email_list) ? body.email_list.map(lower) : []
    if (typeof body.name !== 'string' || !Array.isArray(body.sequences) || senders.some(sender => !state.accounts.includes(sender))) return reply({ message: 'Invalid campaign' }, 400)
    const campaign: MockCampaign = { id: randomUUID(), name: body.name, status: 0, organization: state.workspaceId, email_list: senders, email_tag_list: [],
      sequences: body.sequences as MockCampaign['sequences'], campaign_schedule: body.campaign_schedule, timestamp_created: now, timestamp_updated: now }
    state.campaigns[campaign.id] = campaign
    writeMockState(state)
    return reply(campaign)
  }
  if (request.method === 'POST' && (match = route.match(/^\/campaigns\/([^/]+)\/activate$/))) {
    const campaign = state.campaigns[match[1]]
    if (!campaign) return missing()
    campaign.status = 1
    campaign.timestamp_updated = now
    sendFirstStep(state, campaign)
    writeMockState(state)
    return reply(campaign)
  }
  if (request.method === 'GET' && route === '/campaigns/analytics') {
    const campaign = state.campaigns[url.searchParams.get('id') ?? '']
    if (!campaign) return reply([])
    const emails = state.emails.filter(email => email.campaign_id === campaign.id)
    return reply([{ campaign_id: campaign.id, campaign_status: campaign.status, leads_count: Object.values(state.leads).filter(lead => lead.campaign === campaign.id).length,
      emails_sent_count: emails.filter(email => email.ue_type !== 2).length, reply_count: emails.filter(email => email.ue_type === 2).length,
      reply_count_unique: new Set(emails.filter(email => email.ue_type === 2).map(email => email.lead)).size, open_count: 0, bounced_count: 0 }])
  }
  if (request.method === 'GET' && route === '/campaigns/analytics/daily') return reply([])
  if (request.method === 'GET' && (match = route.match(/^\/campaigns\/([^/]+)$/))) {
    const campaign = state.campaigns[match[1]]
    return campaign ? reply(campaign) : missing()
  }
  if (request.method === 'POST' && route === '/leads') {
    const campaign = state.campaigns[typeof body.campaign === 'string' ? body.campaign : '']
    const email = lower(body.email)
    if (!campaign || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply({ message: 'Invalid lead' }, 400)
    const lead: MockLead = { id: randomUUID(), email, campaign: campaign.id, first_name: String(body.first_name ?? ''), last_name: String(body.last_name ?? ''),
      company_name: String(body.company_name ?? ''), status: 1, timestamp_created: now }
    state.leads[lead.id] = lead
    writeMockState(state)
    return reply(lead)
  }
  if (request.method === 'POST' && route === '/leads/list') {
    const items = Object.values(state.leads).filter(lead => lead.campaign === body.campaign)
      .map(lead => ({ ...lead, email_open_count: 0, email_click_count: 0, lt_interest_status: null,
        email_reply_count: new Set(state.emails.filter(email => email.campaign_id === lead.campaign && email.lead === lead.email && email.ue_type === 2).map(email => email.id)).size }))
    return reply({ items })
  }
  if (request.method === 'GET' && route === '/emails') return reply(listEmails(state, url.searchParams))
  if (request.method === 'GET' && (match = route.match(/^\/emails\/([^/]+)$/))) {
    const email = state.emails.find(item => item.id === match![1])
    return email ? reply(email) : missing()
  }
  if (request.method === 'POST' && route === '/emails/reply') {
    const target = state.emails.find(item => item.id === body.reply_to_uuid)
    const text = typeof body.body === 'object' && body.body && typeof (body.body as { text?: unknown }).text === 'string' ? (body.body as { text: string }).text : ''
    if (!target || target.eaccount !== lower(body.eaccount) || !text) return reply({ message: 'Invalid reply' }, 400)
    const sent: MockEmail = { ...target, id: randomUUID(), timestamp_created: now, timestamp_email: now, subject: String(body.subject ?? target.subject),
      from_address_email: target.eaccount, to_address_email_list: target.lead, body: { text }, ue_type: 3, is_auto_reply: 0, is_unread: 0 }
    state.emails.push(sent)
    writeMockState(state)
    return reply(sent)
  }
  return reply({ message: 'Mock route not implemented' }, 404)
}
