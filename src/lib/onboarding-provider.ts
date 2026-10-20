import 'server-only'
import { z } from 'zod'

export type ConnectionState = 'pending' | 'connected' | 'failed' | 'expired' | 'uncertain'
export type ConnectionFailureCode = 'account_create_required' | 'account_read_required' | 'key_rejected' | 'access_denied' | 'rate_limited' | 'service_unavailable' | 'workspace_mismatch' | 'mailbox_mismatch' | 'account_not_ready'
export type ConnectionResult = {
  state: ConnectionState; failureCode?: ConnectionFailureCode; remoteSession?: string; remoteAccount?: string; authUrl?: string; address?: string
}
export type ConnectionContext = {
  channel: 'email' | 'linkedin'; email: string; workspace: string; credential: string
  remoteSession: string | null; remoteAccount: string | null
}
export type ProviderOptions = { key: string; fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number }
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

async function readProviderJson(response: Response): Promise<unknown> {
    const reader = response.body?.getReader()
    if (!reader) throw new ProviderFailure('uncertain')
    let size = 0; let text = ''; const decoder = new TextDecoder('utf-8', { fatal: true })
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > 65536) { await reader.cancel(); throw new ProviderFailure('uncertain') }
        text += decoder.decode(value, { stream: true })
      }
      return JSON.parse(text + decoder.decode()) as unknown
    } finally { reader.releaseLock() }
}

function transport(channel: 'email' | 'linkedin', options: ProviderOptions) {
  const signal = AbortSignal.any([AbortSignal.timeout(Math.min(options.timeoutMs ?? 12000, 12000)), ...(options.signal ? [options.signal] : [])])
  return async (path: string, body?: unknown): Promise<unknown> => {
    const response = await (options.fetch ?? fetch)(`${channel === 'email' ? 'https://api.instantly.ai/api/v2' : 'https://api.heyreach.io/api/public'}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(channel === 'email' ? { Authorization: `Bearer ${options.key}` } : { 'X-API-KEY': options.key }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal, cache: 'no-store', redirect: 'error',
    })
    // The authentication guide documents 200; the endpoint reference lists 204.
    // This endpoint proves validity through its status, not a JSON response body.
    if (channel === 'linkedin' && path === '/auth/CheckApiKey') {
      await response.body?.cancel()
      if (response.status === 200 || response.status === 204) return null
      console.warn('Integration key verification rejected', { channel, status: response.status })
      throw new ProviderFailure('failed', response.status)
    }
    if (!response.ok) {
      let failureCode: ConnectionFailureCode | undefined
      if (channel === 'email' && [401, 403].includes(response.status)) {
        // Inspect only a bounded response and return fixed codes. Never expose service text.
        try {
          const body = z.object({ message: z.string().max(2000) }).safeParse(await readProviderJson(response))
          if (body.success && body.data.message.startsWith('Invalid scope.')) {
            failureCode = body.data.message.startsWith('Invalid scope. Required: accounts:create.') ? 'account_create_required'
              : body.data.message.startsWith('Invalid scope. Required: accounts:read.') ? 'account_read_required' : 'access_denied'
          }
        } catch { /* The HTTP status remains authoritative when the error body is malformed. */ }
      } else await response.body?.cancel()
      throw new ProviderFailure([400, 401, 403, 409, 422, 429].includes(response.status) ? 'failed' : 'uncertain', response.status, failureCode)
    }
    if (response.status === 204) return null
    return readProviderJson(response)
  }
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

export async function connectAccount(context: ConnectionContext, action: 'start' | 'poll' | 'pin', options: ProviderOptions,
  input: { password?: string; country?: string; pin?: string; provider?: EmailProvider } = {}): Promise<ConnectionResult> {
  let stage = 'workspace_check'
  let verifiedEmailRequest: ReturnType<typeof transport> | undefined
  try {
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
      stage = 'google_status'
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
        z.object({ status: z.literal('pending') }), z.object({ status: z.literal('expired') }), z.object({ status: z.literal('error') }),
        z.object({ status: z.literal('success'), email, account_id: email }),
      ]).parse(statusResponse)
      if (result.status === 'success') {
        if (result.email !== context.email || result.account_id !== context.email) return { state: 'failed', failureCode: 'mailbox_mismatch' }
        stage = 'account_check'
        return await confirmEmailAccount(context, request)
      }
      return { state: result.status === 'error' ? 'failed' : result.status }
    }
    if (action === 'start') {
      if (!input.password || !input.country) return { state: 'failed' }
      const result = z.object({ linkedInAccountId: remoteId }).parse(await request('/li_account/Connect', {
        username: context.email, password: input.password, twoFactorAuthKey: '', proxyCountryCode: input.country, inboxScrapeMode: 'HeyReachOnly',
      }))
      return { state: 'pending', remoteAccount: result.linkedInAccountId }
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
      return { state: 'connected', remoteAccount: id, address: url.href }
    }
    if (result.failureReason || result.status === 'Disconnected') return { state: 'failed' }
    // The public API does not enumerate all intermediate states. Keep polling;
    // expose the PIN form throughout pending rather than guessing status names.
    return { state: 'pending' }
  } catch (error) {
    // Never return/log provider text, password, PIN, key or transport diagnostics.
    // Poll/PIN failures on HeyReach are safe to check again; Connect is never replayed.
    if (context.channel === 'linkedin' && action !== 'start') return { state: 'pending' }
    if (context.channel === 'email') {
      // OAuth terminal results are consumed on read. An unreadable/lost result
      // must never replay login or the session read. Independently confirm the
      // reserved mailbox with one read-only request, using the already verified
      // workspace and the same deadline. This records setup, not sending rights.
      if (action === 'poll' && stage === 'google_status' && verifiedEmailRequest
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
    return { state: error instanceof ProviderFailure ? error.state : 'uncertain' }
  }
}
