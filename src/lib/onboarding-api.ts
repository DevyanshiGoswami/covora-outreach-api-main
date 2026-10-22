import 'server-only'
import { resolveIntegrationCredential } from './integration-credentials'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from './database.types'
import { ApiError, checkDatabaseError, createOutboundHandler, json, readJson, type OutboundApiConfig } from './outbound-http'
import { requireRuntimeDatabase } from './runtime-config'
import { channelSchema, peopleSchema, portalContextSchema } from './onboarding-contract'
import { checkConnectionWorkspace, disconnectAccount, connectAccount, emailAuthorizationUrl, reviewEmailAccount, reviewLinkedinAttempt, type ConnectionResult } from './onboarding-provider'
import { createProviderCallLogger } from './provider-call-log'
import { linkedinCookies, linkedinProfile } from './linkedin-session'

const email = z.string().trim().toLowerCase().pipe(z.email().max(254))
const workspaceOption = z.object({ id: z.string().regex(/^[a-z0-9-]{1,60}$/), label: z.string().min(1).max(100),
  channel: channelSchema, workspaceId: z.string().min(1).max(200), credentialRef: z.string(),
}).refine(row => new RegExp(`^OUTREACH_${row.channel === 'email' ? 'INSTANTLY' : 'HEYREACH'}_[A-Z0-9_]{1,100}$`).test(row.credentialRef)
  && (row.channel !== 'email' || z.uuid().safeParse(row.workspaceId).success))
export type OnboardingApiConfig = OutboundApiConfig & {
  serviceKey: string; credentials?: Readonly<Record<string, string | undefined>>; workspaces?: unknown; providerFetch?: typeof fetch
}
function deploymentOptions(config?: OnboardingApiConfig) {
  try {
    const result = z.array(workspaceOption).max(100).parse(config?.workspaces ?? JSON.parse(process.env.OUTREACH_ONBOARDING_WORKSPACES ?? '[]'))
    if (new Set(result.map(row => row.id)).size !== result.length) throw new Error()
    return result
  } catch { throw new ApiError(500) }
}
async function options(config?: OnboardingApiConfig) {
  const saved = await service(config).from('outreach_integrations').select('id,label,channel,remote_workspace_id,credential_ref').order('id').limit(101)
  checkDatabaseError(saved.error)
  if (!saved.data || saved.data.length>100) throw new ApiError(500)
  return [...deploymentOptions(config), ...saved.data.map(row => ({ id: `managed-${row.id}`, label: row.label,
    channel: channelSchema.parse(row.channel), workspaceId: row.remote_workspace_id, credentialRef: row.credential_ref }))]
}
async function credential(ref: string, config?: OnboardingApiConfig) {
  return resolveIntegrationCredential(ref, config?.credentials ?? process.env, service(config))
}
function service(config?: OnboardingApiConfig) {
  const runtime = config ?? requireRuntimeDatabase(true)
  if (!runtime.serviceKey) throw new ApiError(500)
  return createClient<Database>(runtime.url, runtime.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      try {
        return await (config?.fetch ?? fetch)(input, { ...init, signal: AbortSignal.timeout(8000), cache: 'no-store', redirect: 'error' })
      } catch { return Response.json({ message: 'Request unavailable' }, { status: 503 }) }
    } },
  })
}

/** The open email sign-in's provider, from its stored sign-in link. */
function emailProviderOf(authUrl: string | null | undefined): 'google' | 'microsoft' | null {
  if (!authUrl) return null
  try { return new URL(authUrl).hostname === 'login.microsoftonline.com' ? 'microsoft' : 'google' } catch { return null }
}

async function input<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (new URL(request.url).search) throw new ApiError(400)
  const parsed = schema.safeParse(await readJson(request))
  if (!parsed.success) throw new ApiError(400)
  return parsed.data
}
async function context(client: SupabaseClient<Database>) {
  const result = await client.rpc('outreach_portal_context')
  checkDatabaseError(result.error)
  return portalContextSchema.parse(result.data)
}
const connectionInput = z.union([
  z.strictObject({ action: z.enum(['disconnect', 'check-disconnect']), connectionId: z.uuid() }),
  z.strictObject({ action: z.literal('start'), personId: z.uuid(), channel: z.literal('linkedin'), method: z.literal('cookies'), email,
    cookies: linkedinCookies, country: z.string().regex(/^[A-Z]{2}$/), profileUrl: linkedinProfile,
    userAgent: z.string().min(1).max(512).regex(/^[\x20-\x7e]+$/) }),
  z.strictObject({ action: z.literal('review'), personId: z.uuid(), channel: channelSchema }),
  z.strictObject({ action: z.literal('start'), personId: z.uuid(), channel: z.literal('email'), provider: z.enum(['google', 'microsoft']).optional(), email: email.optional() }),
  z.strictObject({ action: z.literal('switch'), personId: z.uuid(), channel: z.literal('email'), provider: z.enum(['google', 'microsoft']), email: email.optional() }),
  z.strictObject({ action: z.literal('start'), personId: z.uuid(), channel: z.literal('linkedin'), email,
    password: z.string().min(1).max(512), country: z.string().regex(/^[A-Z]{2}$/),
  }),
  z.strictObject({ action: z.literal('poll'), personId: z.uuid(), channel: channelSchema }),
  z.strictObject({ action: z.literal('pin'), personId: z.uuid(), channel: z.literal('linkedin'), pin: z.string().regex(/^[0-9]{4,10}$/) }),
])
const privateContext = z.object({ channel: channelSchema, email, workspace: z.string(), credential: z.string(),
  remoteSession: z.string().nullable(), remoteAccount: z.string().nullable(),
  expectedProfileUrl: z.string().nullable().optional(),
  verifiedProfileUrl: z.string().nullable().optional(),
})

export function createOnboardingHandlers(config?: OnboardingApiConfig) {
  const handle = createOutboundHandler(config, {
    400: 'Check the details and try again. This account or workspace may already be assigned.',
    401: 'Sign in to continue.', 403: 'You do not have access to this onboarding action.',
    500: 'Unable to complete the request. Refresh to check its status before trying again.',
  })
  return {
    context: handle(async (_request, client) => json(await context(client))),
    createClient: handle(async (request, client) => {
      const value = await input(request, z.strictObject({ id: z.uuid(), name: z.string().trim().min(1).max(100) }))
      const result = await client.rpc('create_outreach_client', { p_id: value.id, p_name: value.name })
      checkDatabaseError(result.error)
      return json({ clientId: z.uuid().parse(result.data) }, 201)
    }),
    removeClient: handle(async (request, client) => {
      const value = await input(request, z.strictObject({ clientId: z.uuid(), name: z.string().min(1).max(200) }))
      const result = await client.rpc('remove_outreach_client', { p_client_id: value.clientId, p_name: value.name })
      if (result.error?.code === '55000') return json({ error: 'A reply is being sent. Wait a minute, refresh, and try again.' }, 409)
      checkDatabaseError(result.error)
      return json({ ok: true })
    }),
    people: handle(async (request, client) => {
      const params = [...new URL(request.url).searchParams]
      if (params.length !== 1 || params[0][0] !== 'clientId' || !z.uuid().safeParse(params[0][1]).success) throw new ApiError(400)
      const result = await client.rpc('list_outreach_people', { p_client: params[0][1] })
      checkDatabaseError(result.error)
      return json({ people: peopleSchema.parse(result.data) })
    }),
    addPerson: handle(async (request, client) => {
      const value = await input(request, z.strictObject({ clientId: z.uuid(), name: z.string().trim().min(1).max(100), email }))
      const result = await client.rpc('create_outreach_person', { p_client_id: value.clientId, p_name: value.name, p_email: value.email })
      checkDatabaseError(result.error)
      return json({ personId: z.uuid().parse(result.data) }, 201)
    }),
    integrations: handle(async (request, client) => {
      const params = [...new URL(request.url).searchParams]
      if (params.length !== 1 || params[0][0] !== 'clientId' || !z.uuid().safeParse(params[0][1]).success) throw new ApiError(400)
      const actor = await context(client); const clientId = params[0][1]
      if (!actor.workspaces.some(row => row.id === clientId)) throw new ApiError(403)
      const admin = service(config)
      const [mail, linkedin] = await Promise.all([
        admin.from('outreach_account_workspaces').select('credential_ref,remote_workspace_id,enabled').eq('client_id', clientId).maybeSingle(),
        admin.from('outreach_reply_workspaces').select('credential_ref,remote_workspace_id,enabled').eq('client_id', clientId).eq('channel', 'linkedin').maybeSingle(),
      ])
      checkDatabaseError(mail.error); checkDatabaseError(linkedin.error)
      const catalog = actor.isOwner ? await options(config) : []
      const assignment = (channel: 'email' | 'linkedin', binding: typeof mail.data) => {
        if (!binding) return null
        const option = catalog.find(row => row.channel === channel && row.credentialRef === binding.credential_ref && row.workspaceId === binding.remote_workspace_id)
        return { optionId: option?.id ?? null, label: option?.label ?? 'Connection configured outside Integrations', enabled: binding.enabled }
      }
      return json({ status: { email: Boolean(mail.data?.enabled && await credential(mail.data.credential_ref, config)),
        linkedin: Boolean(linkedin.data?.enabled && await credential(linkedin.data.credential_ref, config)) },
      ...(actor.isOwner ? { assignments: { email: assignment('email', mail.data), linkedin: assignment('linkedin', linkedin.data) } } : {}),
      options: catalog.map(row => ({ id: row.id, label: row.label, channel: row.channel, keyConfigured: row.credentialRef.includes('_VAULT_') || Boolean((config?.credentials ?? process.env)[row.credentialRef]?.trim()) })) })
    }),
    bindIntegration: handle(async (request, client) => {
      const value = await input(request, z.strictObject({ clientId: z.uuid(), optionId: z.string().min(1).max(60) }))
      const actor = await context(client)
      if (!actor.isOwner || !actor.workspaces.some(row => row.id === value.clientId)) throw new ApiError(403)
      const option = (await options(config)).find(row => row.id === value.optionId)
      if (!option) throw new ApiError(400)
      const key = await credential(option.credentialRef, config)
      if (!key || !await checkConnectionWorkspace(option.channel, option.workspaceId, { key, fetch: config?.providerFetch, signal: request.signal,
        log: createProviderCallLogger(service(config), { source: 'integration_check', integrationId: option.id }) })) {
        return json({ error: 'Provider authentication failed. Ask your deployment administrator to check the configured key and workspace.' }, 400)
      }
      const result = await service(config).rpc('bind_outreach_connection_workspace', { p_actor: actor.userId, p_client: value.clientId,
        p_channel: option.channel, p_workspace: option.workspaceId, p_credential: option.credentialRef })
      checkDatabaseError(result.error)
      return json({ ok: true })
    }),
    invite: handle(async (request, client) => {
      const value = await input(request, z.strictObject({ clientId: z.uuid(), email, role: z.enum(['client_admin', 'client_member', 'client_viewer', 'operator']).default('client_admin') }))
      // The invitation RPC independently checks the inviter and permitted target role.
      const invitation = await client.rpc('create_outreach_invitation', { p_client_id: value.clientId, p_email: value.email, p_role: value.role })
      checkDatabaseError(invitation.error)
      const created = z.tuple([z.object({ invitation_id: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/), expires_at: z.string() })]).parse(invitation.data)[0]
      // Only invite NEW Auth identities. Never return a magic/recovery link for an
      // existing user: that would let the inviting admin take over their account.
      const link = await service(config).auth.admin.generateLink({ type: 'invite', email: value.email })
      if (link.error && !['email_exists', 'user_already_exists'].includes(link.error.code ?? '')) {
        return json({ invitationId: created.invitation_id, token: created.token, expiresAt: created.expires_at,
          loginToken: null, notice: 'The team invitation is ready. Login provisioning was unavailable; existing users can sign in, or ask the administrator to reissue the invitation.' })
      }
      return json({ invitationId: created.invitation_id, token: created.token, expiresAt: created.expires_at,
        loginToken: link.data.properties?.hashed_token ?? null,
        notice: link.error ? 'This person already has a login. They will sign in to accept the invitation.' : 'Share this private link only with the invited person. It allows them to set their password.' })
    }),
    connection: handle(async (request, client) => {
      const value = await input(request, connectionInput)
      if (value.action === 'disconnect' || value.action === 'check-disconnect') {
        const prepared = await client.rpc('prepare_outreach_disconnect', { p_connection: value.connectionId, p_action: value.action === 'disconnect' ? 'disconnect' : 'check' })
        if (prepared.error?.code === '22023') return json({ error: 'Account removal is unavailable.', failureCode: prepared.error.message === 'Account has a pending reply' ? 'disconnect_pending_reply' : 'disconnect_not_confirmed' }, 400)
        checkDatabaseError(prepared.error)
        const claim = z.tuple([z.object({ connection_id: z.uuid(), claim_token: z.uuid().nullable(), perform_delete: z.boolean() })]).parse(prepared.data)[0]
        const admin = service(config)
        let failureCode: string | undefined
        if (claim.claim_token) {
          const read = await admin.rpc('read_outreach_disconnect', { p_id: claim.connection_id, p_lease: claim.claim_token })
          checkDatabaseError(read.error)
          const scope = privateContext.safeParse(read.data)
          if (!scope.success) throw new ApiError(403)
          const key = await credential(scope.data.credential, config)
          const result = key ? await disconnectAccount(scope.data, claim.perform_delete, { key, fetch: config?.providerFetch, signal: request.signal,
            log: createProviderCallLogger(admin, { source: 'disconnect', connectionId: claim.connection_id }) })
            : { outcome: claim.perform_delete ? 'rejected' as const : 'uncertain' as const, failureCode: 'disconnect_access_denied' }
          failureCode = result.failureCode
          const finished = await admin.rpc('finish_outreach_disconnect', { p_id: claim.connection_id, p_lease: claim.claim_token, p_outcome: result.outcome })
          checkDatabaseError(finished.error)
          if (!finished.data) throw new ApiError(403)
        }
        const saved = await admin.from('outreach_connections').select('id,state').eq('id', claim.connection_id).single()
        checkDatabaseError(saved.error)
        if (!saved.data) throw new ApiError(500)
        return json({ connectionId: saved.data.id, state: saved.data.state, authUrl: null, ...(failureCode ? { failureCode } : {}) })
      }
      if (!('personId' in value)) throw new ApiError(400)
      if (value.action === 'review' && value.channel === 'linkedin') {
        // A stuck LinkedIn attempt: restore it to status checks, or expire it once its window passes.
        const prepared = await client.rpc('prepare_outreach_linkedin_review', { p_person: value.personId })
        checkDatabaseError(prepared.error)
        const claim = z.tuple([z.object({ connection_id: z.uuid(), claim_token: z.uuid().nullable() })]).parse(prepared.data)[0]
        const admin = service(config)
        let outcome: 'restore' | 'missing' | 'unavailable' | undefined
        if (claim.claim_token) {
          const read = await admin.rpc('read_outreach_linkedin_review', { p_id: claim.connection_id, p_lease: claim.claim_token })
          checkDatabaseError(read.error)
          const scope = privateContext.safeParse(read.data)
          if (!scope.success) throw new ApiError(403)
          const key = await credential(scope.data.credential, config)
          const result = key ? await reviewLinkedinAttempt(scope.data, { key, fetch: config?.providerFetch, signal: request.signal,
            log: createProviderCallLogger(admin, { source: 'connection', connectionId: claim.connection_id }) }) : { outcome: 'unavailable' as const }
          outcome = result.outcome
          const finished = await admin.rpc('finish_outreach_linkedin_review', { p_id: claim.connection_id, p_lease: claim.claim_token, p_outcome: outcome,
            ...(result.outcome === 'restore' ? { p_remote_account: result.remoteAccount } : {}) })
          checkDatabaseError(finished.error)
          if (!finished.data) throw new ApiError(403)
        }
        const saved = await admin.from('outreach_connections').select('id,state,expires_at').eq('id', claim.connection_id).single()
        checkDatabaseError(saved.error)
        if (!saved.data) throw new ApiError(500)
        return json({ connectionId: saved.data.id, state: saved.data.state, expiresAt: saved.data.expires_at, authUrl: null,
          ...(saved.data.state === 'pending' ? { nextStep: 'check_status' } : {}),
          reviewStatus: outcome === 'restore' ? 'restored' : outcome === 'missing' ? (saved.data.state === 'expired' ? 'missing' : 'waiting') : outcome ?? 'checking' })
      }
      if (value.action === 'review') {
        const prepared = await client.rpc('prepare_outreach_email_review', { p_person: value.personId })
        checkDatabaseError(prepared.error)
        const claim = z.tuple([z.object({ connection_id: z.uuid(), claim_token: z.uuid().nullable() })]).parse(prepared.data)[0]
        const admin = service(config)
        let outcome: 'connected' | 'missing' | 'unavailable' | undefined
        let failureCode: ConnectionResult['failureCode']
        if (claim.claim_token) {
          const read = await admin.rpc('read_outreach_email_review', { p_id: claim.connection_id, p_lease: claim.claim_token })
          checkDatabaseError(read.error)
          const scope = privateContext.safeParse(read.data)
          if (!scope.success) throw new ApiError(403)
          const key = await credential(scope.data.credential, config)
          const result = key ? await reviewEmailAccount(scope.data, { key, fetch: config?.providerFetch, signal: request.signal,
            log: createProviderCallLogger(admin, { source: 'email_review', connectionId: claim.connection_id }) })
            : { outcome: 'unavailable' as const, failureCode: 'key_rejected' as const }
          outcome = result.outcome; failureCode = result.failureCode
          const finished = await admin.rpc('finish_outreach_email_review', { p_id: claim.connection_id, p_lease: claim.claim_token, p_outcome: outcome })
          checkDatabaseError(finished.error)
          if (!finished.data) throw new ApiError(403)
        }
        const saved = await admin.from('outreach_connections').select('id,state,expires_at').eq('id', claim.connection_id).single()
        checkDatabaseError(saved.error)
        if (!saved.data) throw new ApiError(500)
        return json({ connectionId: saved.data.id, state: saved.data.state, expiresAt: saved.data.expires_at, authUrl: null,
          reviewStatus: outcome === 'missing' ? (saved.data.state === 'expired' ? 'missing' : 'waiting') : outcome ?? 'checking',
          ...(failureCode ? { failureCode } : {}) })
      }
      if (value.action === 'switch') {
        // An explicit request to use the other provider while a sign-in is open. The reserved mailbox
        // is checked first: a sign-in that already completed is kept as connected, and one that cannot
        // be checked stays open exactly as it was.
        const open = await service(config).from('outreach_connections').select('state,auth_url').eq('person_id', value.personId).eq('channel', 'email')
          .order('created_at', { ascending: false }).limit(1).maybeSingle()
        const openProvider = open.data?.state === 'pending' ? emailProviderOf(open.data.auth_url) : null
        if (openProvider && openProvider !== value.provider) {
          const switching = await client.rpc('prepare_outreach_email_switch', { p_person: value.personId })
          if (switching.error?.code === '22023' && switching.error.message === 'Connection retry too soon')
            return json({ error: 'Connection request rejected.', failureCode: 'connection_retry_later' }, 400)
          checkDatabaseError(switching.error)
          const claim = z.tuple([z.object({ connection_id: z.uuid(), claim_token: z.uuid().nullable() })]).parse(switching.data)[0]
          if (claim.claim_token) {
            const admin = service(config)
            const read = await admin.rpc('read_outreach_email_review', { p_id: claim.connection_id, p_lease: claim.claim_token })
            checkDatabaseError(read.error)
            const scope = privateContext.safeParse(read.data)
            if (!scope.success) throw new ApiError(403)
            const key = await credential(scope.data.credential, config)
            const result = key ? await reviewEmailAccount(scope.data, { key, fetch: config?.providerFetch, signal: request.signal,
              log: createProviderCallLogger(admin, { source: 'email_review', connectionId: claim.connection_id }) }) : { outcome: 'unavailable' as const }
            const finished = await admin.rpc('finish_outreach_email_switch', { p_id: claim.connection_id, p_lease: claim.claim_token, p_outcome: result.outcome })
            checkDatabaseError(finished.error)
            if (!finished.data) throw new ApiError(403)
            if (result.outcome === 'unavailable') {
              const kept = await admin.from('outreach_connections').select('id,state,expires_at').eq('id', claim.connection_id).single()
              checkDatabaseError(kept.error)
              if (!kept.data) throw new ApiError(500)
              return json({ connectionId: kept.data.id, state: kept.data.state, expiresAt: kept.data.expires_at, authUrl: null,
                failureCode: ('failureCode' in result && result.failureCode) || 'service_unavailable' })
            }
          }
        }
      }
      const action = value.action === 'switch' ? 'start' : value.action
      const prepared = 'method' in value && value.method === 'cookies'
        ? await client.rpc('prepare_outreach_linkedin_cookies', { p_person: value.personId, p_email: value.email, p_profile: value.profileUrl })
        : await client.rpc('prepare_outreach_connection', { p_person: value.personId, p_channel: value.channel, p_action: action,
          ...('email' in value ? { p_email: value.email } : {}) })
      if (prepared.error?.code === '22023') {
        const failures: Record<string, string> = {
          'Connection retry too soon': 'connection_retry_later',
          'Wait before starting another connection': 'connection_retry_later',
          'LinkedIn identity requires review': 'linkedin_identity_locked',
          'Connection check in progress': 'linkedin_check_in_progress',
          'Connection identity reserved': 'connection_identity_reserved',
        }
        const failureCode = Object.hasOwn(failures, prepared.error.message) ? failures[prepared.error.message] : undefined
        if (failureCode) return json({ error: 'Connection request rejected.', failureCode }, 400)
      }
      checkDatabaseError(prepared.error)
      const claim = z.tuple([z.object({ connection_id: z.uuid(), claim_token: z.uuid().nullable() })]).parse(prepared.data)[0]
      const admin = service(config)
      let failureCode: ConnectionResult['failureCode']
      let nextStep: ConnectionResult['nextStep']
      if (claim.claim_token) {
        const result = await admin.rpc('read_outreach_connection', { p_id: claim.connection_id, p_lease: claim.claim_token })
        checkDatabaseError(result.error)
        const scope = privateContext.safeParse(result.data)
        if (!scope.success) throw new ApiError(403)
        const key = await credential(scope.data.credential, config)
        const observation: ConnectionResult = key ? await connectAccount(scope.data, action, { key, fetch: config?.providerFetch, signal: request.signal,
          log: createProviderCallLogger(admin, { source: 'connection', connectionId: claim.connection_id }) }, {
          ...('password' in value ? { password: value.password, country: value.country } : {}),
          ...('cookies' in value ? { cookies: value.cookies, country: value.country, userAgent: value.userAgent } : {}),
          ...('pin' in value ? { pin: value.pin } : {}),
          ...('provider' in value && value.provider ? { provider: value.provider } : {}),
        })
          : { state: 'failed', ...(scope.data.channel === 'email' ? { failureCode: 'key_rejected' as const } : {}) }
        failureCode = observation.failureCode
        nextStep = observation.nextStep
        const finished = await admin.rpc('finish_outreach_connection', {
          p_id: claim.connection_id, p_lease: claim.claim_token, p_state: observation.state,
          ...('remoteSession' in observation && observation.remoteSession ? { p_remote_session: observation.remoteSession } : {}),
          ...('remoteAccount' in observation && observation.remoteAccount ? { p_remote_account: observation.remoteAccount } : {}),
          ...('authUrl' in observation && observation.authUrl ? { p_auth_url: observation.authUrl } : {}),
          ...('address' in observation && observation.address ? { p_address: observation.address } : {}),
        })
        checkDatabaseError(finished.error)
        if (!finished.data) throw new ApiError(403)

      }
      // prepare authorized the same actor even for an idempotent/cache response.
      const saved = await admin.from('outreach_connections').select('id,state,auth_url,expires_at').eq('id', claim.connection_id).single()
      checkDatabaseError(saved.error)
      if (!saved.data) throw new ApiError(500)
      if (action === 'pin' && !claim.claim_token && saved.data.state === 'pending') failureCode = 'linkedin_check_in_progress'
      return json({ connectionId: saved.data.id, state: saved.data.state, expiresAt: saved.data.expires_at,
        ...(failureCode ? { failureCode } : {}),
        ...(saved.data.state === 'pending' && nextStep ? { nextStep } : {}),
        authUrl: saved.data.state === 'pending' && saved.data.auth_url ? emailAuthorizationUrl(saved.data.auth_url) : null })
    }),
  }
}
