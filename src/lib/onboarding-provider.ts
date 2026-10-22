import 'server-only'
import { z } from 'zod'
import { linkedinCookies, linkedinProfileUrl, type LinkedInCookie } from './linkedin-session'
import { normalizeProviderPath, providerRequestId, redactProviderText, type ProviderCallEntry, type ProviderCallLogger } from './provider-call-log'

export type ConnectionState = 'pending' | 'connected' | 'failed' | 'expired' | 'uncertain'
type LinkedInFailureCode = 'linkedin_profile_mismatch' | 'linkedin_access_denied' | 'linkedin_no_free_seat' | 'linkedin_session_rejected' | 'linkedin_location_unavailable' | 'linkedin_request_rejected'
export type ConnectionFailureCode = 'account_create_required' | 'account_read_required' | 'key_rejected' | 'access_denied' | 'rate_limited' | 'service_unavailable' | 'workspace_mismatch' | 'mailbox_mismatch' | 'account_not_ready' | 'personal_gmail_unsupported' | 'account_already_assigned' | 'sign_in_rejected' | 'consent_denied' | LinkedInFailureCode
export type ConnectionResult = {
  state: ConnectionState; failureCode?: ConnectionFailureCode; remoteSession?: string; remoteAccount?: string; authUrl?: string; address?: string
}
export type ConnectionContext = {
  channel: 'email' | 'linkedin'; email: string; workspace: string; credential: string
  remoteSession: string | null; remoteAccount: string | null
  expectedProfileUrl?: string | null
}
export type ProviderOptions = { key: string; fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; log?: ProviderCallLogger }
export type EmailProvider = 'google' | 'microsoft'
class ProviderFailure extends Error {
  constructor(readonly state: 'failed' | 'uncertain', readonly status?: number, readonly failureCode?: ConnectionFailureCode) { super('Connection unavailable') }
}
const remoteId = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9][0-9]{0,15}$/)])
  .transform(String).refine(value => Number.isSafeInteger(Number(value)))
const email = z.email().max(254).transform(value => value.toLowerCase())

export function googleAuthorizationUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' || url.port || url.username || url.password
    || !['/o/oauth2/auth', '/o/oauth2/v2/auth'].includes(url.pathname) || !url.searchParams.get('state')) throw new ProviderFailure('uncertain')
  return url.href
}

export function microsoftAuthorizationUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'login.microsoftonline.com' || url.port || url.username || url.password
    || !/^\/[A-Za-z0-9.-]+\/oauth2\/(v2\.0\/)?authorize$/.test(url.pathname) || !url.searchParams.get('state')) throw new ProviderFailure('uncertain')
  return url.href
}

/** Saved sign-in links are rechecked against the provider they claim to come from. */
export function emailAuthorizationUrl(value: string): string {
  return new URL(value).hostname === 'login.microsoftonline.com' ? microsoftAuthorizationUrl(value) : googleAuthorizationUrl(value)
}

async function readProviderText(response: Response, limit = 65536): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) throw new ProviderFailure('uncertain')
    let size = 0; let text = ''; const decoder = new TextDecoder('utf-8', { fatal: true })
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > limit) { await reader.cancel(); throw new ProviderFailure('uncertain') }
        text += decoder.decode(value, { stream: true })
      }
      return text + decoder.decode()
    } finally { reader.releaseLock() }
}

async function readProviderJson(response: Response): Promise<unknown> {
  return JSON.parse(await readProviderText(response)) as unknown
}

/** Classify bounded error fields only; never log or return the service text. */
function linkedinRequestFailure(raw: string): LinkedInFailureCode {
  let message = ''
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value === 'string') message = value
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const fields = value as Record<string, unknown>
      message = ['message', 'errorMessage', 'detail', 'error'].map(key => typeof fields[key] === 'string' ? fields[key] : '').join(' ')
      if (fields.errors && typeof fields.errors === 'object' && !Array.isArray(fields.errors)) {
        const keys = Object.keys(fields.errors)
        if (keys.some(key => /^(proxyCountryCode|customProxy)$/i.test(key))) return 'linkedin_location_unavailable'
      }
    }
  } catch { if (!/^[\s]*[<{[]/.test(raw)) message = raw }
  if (/\b(proxy|country|proxyCountryCode|customProxy)\b/i.test(message)) return 'linkedin_location_unavailable'
  if (/\b(cookie|cookies|session)\b.{0,80}\b(invalid|expired|rejected)\b|\b(invalid|expired|rejected)\b.{0,80}\b(cookie|cookies|session)\b/i.test(message)) return 'linkedin_session_rejected'
  return 'linkedin_request_rejected'
}

const SENSITIVE_FIELD = /^(value|password|pin|username|email|useragent|twofactorauthkey)$/i
/** Values of credential or identity fields in a request body, wherever they are nested. */
function sensitiveValues(value: unknown, field = '', depth = 0): string[] {
  if (typeof value === 'string') return SENSITIVE_FIELD.test(field) ? [value] : []
  if (depth > 4 || !value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, item]) => sensitiveValues(item, Array.isArray(value) ? field : key, depth + 1))
}

/** Bounded read of an error body; null when it is missing, oversized or not UTF-8. */
async function readErrorText(response: Response, limit: number): Promise<string | null> {
  try { return await readProviderText(response, limit) }
  catch { await response.body?.cancel().catch(() => {}); return null }
}

function transport(channel: 'email' | 'linkedin', options: ProviderOptions, limitMs = 12000) {
  const signal = AbortSignal.any([AbortSignal.timeout(Math.min(options.timeoutMs ?? limitMs, limitMs)), ...(options.signal ? [options.signal] : [])])
  return async (path: string, body?: unknown, override?: 'DELETE'): Promise<unknown> => {
    const method = override ?? (body === undefined ? 'GET' : 'POST')
    const started = performance.now()
    // Masked diagnostics only: the key, request body and raw identifiers never reach the log.
    // Anything this request sent is scrubbed first, in case the provider echoes it back.
    const sent = [options.key, ...sensitiveValues(body)].filter(value => value.length >= 6).sort((a, b) => b.length - a.length)
    const record = async (status: number | null, outcome: ProviderCallEntry['outcome'], requestId: string | null, errorText: string | null) => {
      try {
        const scrubbed = errorText === null ? null : sent.reduce((text, value) => text.split(value).join('[redacted]'), errorText)
        await options.log?.({ channel, method, operation: normalizeProviderPath(path), status, outcome,
          durationMs: Math.round(performance.now() - started), requestId, errorExcerpt: scrubbed === null ? null : redactProviderText(scrubbed) })
      } catch { /* Diagnostics never change a provider outcome. */ }
    }
    let response: Response
    try {
      response = await (options.fetch ?? fetch)(`${channel === 'email' ? 'https://api.instantly.ai/api/v2' : 'https://api.heyreach.io/api/public'}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(channel === 'email' ? { Authorization: `Bearer ${options.key}` } : { 'X-API-KEY': options.key }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal, cache: 'no-store', redirect: 'error',
      })
    } catch (error) {
      await record(null, signal.aborted ? 'timeout' : 'network_error', null, null)
      throw error
    }
    const requestId = providerRequestId(response.headers)
    // The authentication guide documents 200; the endpoint reference lists 204.
    // This endpoint proves validity through its status, not a JSON response body.
    if (channel === 'linkedin' && path === '/auth/CheckApiKey') {
      if (response.status === 200 || response.status === 204) {
        await response.body?.cancel()
        await record(response.status, 'ok', requestId, null)
        return null
      }
      await record(response.status, 'http_error', requestId, await readErrorText(response, 16384))
      console.warn('Integration key verification rejected', { channel, status: response.status })
      throw new ProviderFailure('failed', response.status)
    }
    if (!response.ok) {
      const errorText = await readErrorText(response, channel === 'linkedin' ? 16384 : 65536)
      await record(response.status, 'http_error', requestId, errorText)
      let failureCode: ConnectionFailureCode | undefined
      if (channel === 'email' && [401, 403].includes(response.status)) {
        // Inspect only a bounded response and return fixed codes. Never expose service text.
        try {
          const body = z.object({ message: z.string().max(2000) }).safeParse(JSON.parse(errorText ?? ''))
          if (body.success && body.data.message.startsWith('Invalid scope.')) {
            failureCode = body.data.message.startsWith('Invalid scope. Required: accounts:create.') ? 'account_create_required'
              : body.data.message.startsWith('Invalid scope. Required: accounts:read.') ? 'account_read_required' : 'access_denied'
          }
        } catch { /* The HTTP status remains authoritative when the error body is malformed. */ }
      } else if (channel === 'linkedin' && [400, 422].includes(response.status)) {
        // An unreadable rejection must not be described as bad cookies.
        failureCode = errorText === null ? 'linkedin_request_rejected' : linkedinRequestFailure(errorText)
      } else if (channel === 'linkedin' && response.status === 403 && errorText !== null && /\bfree seat\b|\badditional seats\b/i.test(errorText)) {
        // HeyReach refuses new senders when the workspace has no seat left; the key itself is fine.
        failureCode = 'linkedin_no_free_seat'
      }
      throw new ProviderFailure([400, 401, 403, 409, 422, 429].includes(response.status) ? 'failed' : 'uncertain', response.status, failureCode)
    }
    await record(response.status, 'ok', requestId, null)
    if (response.status === 204 || method === 'DELETE') { await response.body?.cancel(); return null }
    return readProviderJson(response)
  }
}

/**
 * Read-only check of what a HeyReach key may do: the key itself, then an Account Login API
 * endpoint with a placeholder account. Never logs in, connects or creates anything.
 */
export async function probeLinkedInAccess(options: ProviderOptions): Promise<{ key: number | null; accountLogin: number | null }> {
  const request = transport('linkedin', options)
  const statusOf = async (path: string) => {
    try { await request(path); return 200 } catch (error) { return error instanceof ProviderFailure ? error.status ?? null : null }
  }
  return { key: await statusOf('/auth/CheckApiKey'), accountLogin: await statusOf('/li_account/GetAccountStatus/1') }
}

/** Validate credentials without creating accounts, campaigns or billable workspaces. */
export async function verifyConnectionWorkspace(channel: 'email' | 'linkedin', workspace: string, options: ProviderOptions): Promise<{ ok: boolean; code?: string }> {
  try {
    const request = transport(channel, options)
    if (channel === 'email') return { ok: z.object({ id: z.uuid() }).parse(await request('/workspaces/current')).id === workspace }
    // CheckApiKey confirms the key. HeyReach's workspace binding is deployment configuration.
    return { ok: await request('/auth/CheckApiKey') === null }
  } catch (error) {
    if (!(error instanceof ProviderFailure)) console.warn('Integration key verification unavailable', { channel })
    const status = error instanceof ProviderFailure ? error.status : undefined
    return { ok: false, code: status === 401 ? 'key_rejected' : status === 403 ? 'provider_access_denied' : status === 429 ? 'provider_rate_limited' : status === undefined || status >= 500 ? 'provider_unavailable' : 'key_verification_failed' }
  }
}

export async function checkConnectionWorkspace(channel: 'email' | 'linkedin', workspace: string, options: ProviderOptions): Promise<boolean> {
  return (await verifyConnectionWorkspace(channel, workspace, options)).ok
}

/** Discover the email workspace from the supplied key. No account or campaign is created. */
export async function discoverEmailWorkspace(options: ProviderOptions): Promise<string | null> {
  try { return z.object({ id: z.uuid() }).parse(await transport('email', options)('/workspaces/current')).id }
  catch { return null }
}

async function confirmEmailAccount(context: ConnectionContext, request: ReturnType<typeof transport>): Promise<ConnectionResult> {
  const account = z.object({ email, organization: z.uuid(), status: z.number(), setup_pending: z.boolean().optional() })
    .parse(await request(`/accounts/${encodeURIComponent(context.email)}`))
  if (account.email !== context.email || account.organization !== context.workspace || account.status !== 1 || account.setup_pending) {
    return { state: 'failed', failureCode: 'account_not_ready' }
  }
  return { state: 'connected', remoteAccount: context.email }
}

/** Independently inspect a reserved mailbox. This never calls an OAuth endpoint. */
export async function reviewEmailAccount(context: ConnectionContext, options: ProviderOptions): Promise<{
  outcome: 'connected' | 'missing' | 'unavailable'; failureCode?: ConnectionFailureCode
}> {
  if (context.channel !== 'email') return { outcome: 'unavailable' }
  let workspaceVerified = false
  try {
    const request = transport('email', options)
    if (z.object({ id: z.uuid() }).parse(await request('/workspaces/current')).id !== context.workspace) {
      return { outcome: 'unavailable', failureCode: 'workspace_mismatch' }
    }
    workspaceVerified = true
    const account = await confirmEmailAccount(context, request)
    return account.state === 'connected' ? { outcome: 'connected' } : { outcome: 'unavailable', failureCode: 'account_not_ready' }
  } catch (error) {
    const status = error instanceof ProviderFailure ? error.status : undefined
    if (workspaceVerified && status === 404) return { outcome: 'missing' }
    return { outcome: 'unavailable', failureCode: (error instanceof ProviderFailure ? error.failureCode : undefined)
      ?? (status === 401 ? 'key_rejected' : status === 403 ? 'access_denied' : status === 429 ? 'rate_limited' : 'service_unavailable') }
  }
}

/** A HeyReach login can outlast the default deadline; this stays inside the 45-second connection lease. */
const LINKEDIN_CONNECT_TIMEOUT_MS = 28000
const LINKEDIN_LIST_TIMEOUT_MS = 5000

/** Senders visible to this key, or null when the list is unavailable or too long to compare completely. */
async function linkedinSenders(options: ProviderOptions): Promise<{ id: string; email: string | null }[] | null> {
  try {
    const result = z.object({ totalCount: z.coerce.number(), items: z.array(z.object({ id: remoteId, emailAddress: z.string().nullish() })) })
      .parse(await transport('linkedin', options, LINKEDIN_LIST_TIMEOUT_MS)('/li_account/GetAll', { offset: 0, limit: 100, keyword: '' }))
    if (result.totalCount > result.items.length) return null
    return result.items.map(item => ({ id: item.id, email: item.emailAddress?.trim().toLowerCase() || null }))
  } catch { return null }
}

export async function connectAccount(context: ConnectionContext, action: 'start' | 'poll' | 'pin', options: ProviderOptions,
  input: { password?: string; country?: string; pin?: string; provider?: EmailProvider; cookies?: LinkedInCookie[]; userAgent?: string } = {}): Promise<ConnectionResult> {
  let stage = 'workspace_check'
  let verifiedEmailRequest: ReturnType<typeof transport> | undefined
  try {
    // The authorized person supplies the expected identity, never browser input.
    // Personal Gmail cannot use this service's Google Workspace OAuth route.
    if (context.channel === 'email' && action === 'start' && /@(gmail|googlemail)\.com$/i.test(context.email)) {
      return { state: 'failed', failureCode: 'personal_gmail_unsupported' }
    }
    const request = transport(context.channel, options)
    if (context.channel === 'email') {
      const workspace = z.object({ id: z.uuid() }).parse(await request('/workspaces/current'))
      if (workspace.id !== context.workspace) return { state: 'failed', failureCode: 'workspace_mismatch' }
      verifiedEmailRequest = request
      if (action === 'start') {
        const provider = input.provider ?? 'google'
        stage = `${provider}_start`
        const result = z.object({ session_id: z.uuid(), auth_url: z.string().max(16000), expires_at: z.iso.datetime({ offset: true }) })
          .parse(await request(`/oauth/${provider}/init`, {}))
        if (Date.parse(result.expires_at) <= Date.now()) return { state: 'expired' }
        return { state: 'pending', remoteSession: result.session_id,
          authUrl: provider === 'microsoft' ? microsoftAuthorizationUrl(result.auth_url) : googleAuthorizationUrl(result.auth_url) }
      }
      if (action !== 'poll' || !context.remoteSession || !z.uuid().safeParse(context.remoteSession).success) return { state: 'failed' }
      stage = 'email_status'
      // Instantly consumes success/error on the first read. The database lease
      // serializes this request and persists its result before replying to the UI.
      const statusResponse = await request(`/oauth/session/status/${encodeURIComponent(context.remoteSession)}`)
      // A partially changed response shape must not hide a known identity mismatch.
      const identity = z.object({ status: z.literal('success'), email: z.unknown().optional(), account_id: z.unknown().optional() }).safeParse(statusResponse)
      if (identity.success && ((typeof identity.data.email === 'string' && identity.data.email.toLowerCase() !== context.email)
        || (typeof identity.data.account_id === 'string' && identity.data.account_id.includes('@') && identity.data.account_id.toLowerCase() !== context.email))) {
        return { state: 'failed', failureCode: 'mailbox_mismatch' }
      }
      const result = z.discriminatedUnion('status', [
        z.object({ status: z.literal('pending') }), z.object({ status: z.literal('expired') }), z.object({ status: z.literal('error'), error: z.string().optional() }),
        z.object({ status: z.literal('success'), email, account_id: email }),
      ]).parse(statusResponse)
      if (result.status === 'success') {
        if (result.email !== context.email || result.account_id !== context.email) return { state: 'failed', failureCode: 'mailbox_mismatch' }
        stage = 'account_check'
        return await confirmEmailAccount(context, request)
      }
      if (result.status === 'error') return { state: 'failed', failureCode: result.error === 'account_exists' ? 'account_already_assigned'
        : result.error === 'access_denied' ? 'consent_denied' : 'sign_in_rejected' }
      return { state: result.status }
    }
    if (action === 'start') {
      if (!input.country || !/^[a-z]{2}$/i.test(input.country)) return { state: 'failed', failureCode: 'linkedin_location_unavailable' }
      // GetProxyCountries returns lowercase codes (us, in, gb), unlike the
      // uppercase examples in the endpoint docs. Preserve the selected country.
      const country = input.country.toLowerCase()
      const cookies = input.cookies ? linkedinCookies.parse(input.cookies) : undefined
      if (cookies && (!input.userAgent || !context.expectedProfileUrl)) return { state: 'failed' }
      if (!cookies && !input.password) return { state: 'failed' }
      // HeyReach can take longer than the default deadline to answer a login, and keeps
      // creating the sender after a lost reply. Snapshot the senders first so a lost reply
      // can be matched to the one sender it created instead of leaving the attempt stuck.
      const before = await linkedinSenders(options)
      try {
        const result = z.object({ linkedInAccountId: remoteId }).parse(await transport('linkedin', options, LINKEDIN_CONNECT_TIMEOUT_MS)(
          cookies ? '/li_account/ConnectWithCookies' : '/li_account/Connect',
          cookies ? { cookies, proxyCountryCode: country, inboxScrapeMode: 'HeyReachOnly', userAgent: input.userAgent }
            : { username: context.email, password: input.password, twoFactorAuthKey: '', proxyCountryCode: country, inboxScrapeMode: 'HeyReachOnly' }))
        return { state: 'pending', remoteAccount: result.linkedInAccountId }
      } catch (error) {
        const lostReply = !(error instanceof ProviderFailure) && !(error instanceof z.ZodError) && !(error instanceof SyntaxError)
        const after = lostReply && before ? await linkedinSenders(options) : null
        const added = before && after ? after.filter(sender => !before.some(known => known.id === sender.id)) : []
        // A browser session is verified against the expected profile on every poll. A password
        // login has no profile to check, so it is adopted only when the sender carries that login.
        if (added.length === 1 && (cookies || added[0].email === context.email)) {
          console.warn('LinkedIn connection recovered after a lost reply', { method: cookies ? 'cookies' : 'password' })
          return { state: 'pending', remoteAccount: added[0].id }
        }
        throw error
      }
    }
    const id = remoteId.parse(context.remoteAccount)
    if (action === 'pin') {
      if (!input.pin) return { state: 'failed' }
      await request('/li_account/SubmitPin', { accountId: Number(id), pin: input.pin })
      return { state: 'pending' }
    }
    const result = z.object({ accountId: remoteId, status: z.string(), failureReason: z.string().nullish(),
      profile: z.object({ profileUrl: z.string() }).nullish(),
    }).parse(await request(`/li_account/GetAccountStatus/${id}`))
    if (result.accountId !== id) return { state: 'failed' }
    if (result.status === 'Connected' && !result.failureReason && result.profile) {
      const url = new URL(result.profile.profileUrl)
      if (url.protocol !== 'https:' || !['www.linkedin.com', 'linkedin.com'].includes(url.hostname) || !url.pathname.startsWith('/in/') || url.username || url.password || url.port) return { state: 'failed' }
      if (context.expectedProfileUrl) {
        const profile = linkedinProfileUrl(url.href)
        if (profile !== context.expectedProfileUrl) return { state: 'failed', failureCode: 'linkedin_profile_mismatch' }
        return { state: 'connected', remoteAccount: id, address: profile }
      }
      return { state: 'connected', remoteAccount: id, address: url.href }
    }
    if (result.failureReason || result.status === 'Disconnected') return { state: 'failed' }
    // The public API does not enumerate all intermediate states. Keep polling;
    // expose the PIN form throughout pending rather than guessing status names.
    return { state: 'pending' }
  } catch (error) {
    // Never return/log provider text, password, PIN, key or transport diagnostics.
    // Poll/PIN failures on HeyReach are safe to check again; Connect is never replayed.
    if (context.channel === 'linkedin') {
      console.warn('LinkedIn account connection failed', { action,
        method: action === 'start' ? input.cookies ? 'cookies' : 'password' : undefined,
        status: error instanceof ProviderFailure ? error.status : undefined,
        failureCode: error instanceof ProviderFailure ? error.failureCode : undefined,
        reason: error instanceof z.ZodError ? 'unexpected_response' : error instanceof ProviderFailure ? 'provider_response' : 'transport_error' })
    }
    if (context.channel === 'linkedin' && action !== 'start') return { state: 'pending' }
    if (context.channel === 'email') {
      // OAuth terminal results are consumed on read. An unreadable/lost result
      // must never replay login or the session read. Independently confirm the
      // reserved mailbox with one read-only request, using the already verified
      // workspace and the same deadline. This records setup, not sending rights.
      if (action === 'poll' && stage === 'email_status' && verifiedEmailRequest
        && (!(error instanceof ProviderFailure) || error.state === 'uncertain')) {
        try {
          const account = await confirmEmailAccount(context, verifiedEmailRequest)
          if (account.state === 'connected') {
            console.warn('Email account connection reconciled', { action, stage })
            return account
          }
        } catch { /* Without independent proof, retain the uncertain outcome. */ }
      }
      const status = error instanceof ProviderFailure ? error.status : undefined
      const failureCode = (error instanceof ProviderFailure ? error.failureCode : undefined)
        ?? (status === 401 ? 'key_rejected' : status === 403 ? 'access_denied' : status === 429 ? 'rate_limited' : 'service_unavailable')
      const reason = error instanceof z.ZodError ? 'unexpected_response' : error instanceof ProviderFailure ? 'provider_response' : 'transport_error'
      console.warn('Email account connection failed', { action, stage, status, failureCode, reason })
      return { state: error instanceof ProviderFailure ? error.state : 'uncertain', failureCode }
    }
    const status = error instanceof ProviderFailure ? error.status : undefined
    const failureCode = (error instanceof ProviderFailure ? error.failureCode : undefined)
      ?? ([401, 403].includes(status ?? 0) ? 'linkedin_access_denied' : status === 429 ? 'rate_limited' : undefined)
    return { state: error instanceof ProviderFailure ? error.state : 'uncertain',
      ...(failureCode ? { failureCode } : {}) }
  }
}

export type DisconnectResult = { outcome: 'removed' | 'rejected' | 'uncertain'; failureCode?: string }
/** Remove only the server-resolved sender. A check never repeats DELETE. */
export async function disconnectAccount(context: ConnectionContext, performDelete: boolean, options: ProviderOptions): Promise<DisconnectResult> {
  let deleteSent = false
  let deleteAccepted = false
  try {
    const request = transport(context.channel, options)
    const emailChannel = context.channel === 'email'
    if (emailChannel) {
      if (context.remoteAccount !== context.email || z.object({ id: z.uuid() }).parse(await request('/workspaces/current')).id !== context.workspace)
        return { outcome: performDelete ? 'rejected' : 'uncertain', failureCode: 'disconnect_identity_mismatch' }
    } else {
      remoteId.parse(context.remoteAccount)
      await request('/auth/CheckApiKey')
    }
    const accountPath = emailChannel ? `/accounts/${encodeURIComponent(context.email)}` : `/li_account/GetById?accountId=${context.remoteAccount}`
    let raw: unknown
    try { raw = await request(accountPath) }
    catch (error) { if (error instanceof ProviderFailure && error.status === 404) return { outcome: 'removed' }; throw error }
    if (!performDelete) return { outcome: 'uncertain', failureCode: 'disconnect_not_confirmed' }
    if (emailChannel) {
      const account = z.object({ email, organization: z.uuid(), is_managed_account: z.boolean().optional() }).parse(raw)
      if (account.email !== context.email || account.organization !== context.workspace)
        return { outcome: 'rejected', failureCode: 'disconnect_identity_mismatch' }
      if (account.is_managed_account) return { outcome: 'rejected', failureCode: 'disconnect_managed_account' }
      // Any campaign assignment blocks removal, including campaigns outside Covora.
      const mappings = z.object({ items: z.array(z.unknown()), next_starting_after: z.string().nullable().optional() })
        .parse(await request(`/account-campaign-mappings/${encodeURIComponent(context.email)}`))
      if (mappings.items.length || mappings.next_starting_after) return { outcome: 'rejected', failureCode: 'disconnect_campaigns' }
    } else {
      const account = z.object({ id: remoteId, emailAddress: email, activeCampaigns: z.number().int().nonnegative() }).parse(raw)
      if (account.id !== context.remoteAccount || account.emailAddress !== context.email)
        return { outcome: 'rejected', failureCode: 'disconnect_identity_mismatch' }
      if (account.activeCampaigns > 0) return { outcome: 'rejected', failureCode: 'disconnect_campaigns' }
    }
    deleteSent = true
    await request(emailChannel ? accountPath : `/li_account/RemoveAccount/${context.remoteAccount}?force=false`, undefined, 'DELETE')
    deleteAccepted = true
    // A success response alone does not release the identity reservation.
    try { await request(accountPath) }
    catch (error) { if (error instanceof ProviderFailure && error.status === 404) return { outcome: 'removed' }; throw error }
    return { outcome: 'uncertain', failureCode: 'disconnect_not_confirmed' }
  } catch (error) {
    const status = error instanceof ProviderFailure ? error.status : undefined
    const rejected = performDelete && (!deleteSent || (!deleteAccepted && status !== undefined && [400,401,403,409,422,429].includes(status)))
    return { outcome: rejected ? 'rejected' : 'uncertain', failureCode: status === 401 || status === 403 ? 'disconnect_access_denied'
      : status === 409 ? 'disconnect_campaigns' : 'disconnect_not_confirmed' }
  }
}
