import 'server-only'
import { resolveIntegrationCredential } from './integration-credentials'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from './database.types'
import { ApiError, checkDatabaseError, createOutboundHandler, json, readJson, type OutboundApiConfig } from './outbound-http'
import { requireRuntimeDatabase } from './runtime-config'
import { channelSchema, peopleSchema, portalContextSchema } from './onboarding-contract'
import { checkConnectionWorkspace, connectAccount, googleAuthorizationUrl, type ConnectionResult } from './onboarding-provider'

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
  z.strictObject({ action: z.literal('start'), personId: z.uuid(), channel: z.literal('email') }),
  z.strictObject({ action: z.literal('start'), personId: z.uuid(), channel: z.literal('linkedin'), email,
    password: z.string().min(1).max(512), country: z.string().regex(/^[A-Z]{2}$/),
  }),
  z.strictObject({ action: z.literal('poll'), personId: z.uuid(), channel: channelSchema }),
  z.strictObject({ action: z.literal('pin'), personId: z.uuid(), channel: z.literal('linkedin'), pin: z.string().regex(/^[0-9]{4,10}$/) }),
])
const privateContext = z.object({ channel: channelSchema, email, workspace: z.string(), credential: z.string(),
  remoteSession: z.string().nullable(), remoteAccount: z.string().nullable(),
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
      if (!key || !await checkConnectionWorkspace(option.channel, option.workspaceId, { key, fetch: config?.providerFetch, signal: request.signal })) {
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
      const prepared = await client.rpc('prepare_outreach_connection', { p_person: value.personId, p_channel: value.channel, p_action: value.action,
        ...('email' in value ? { p_email: value.email } : {}) })
      checkDatabaseError(prepared.error)
      const claim = z.tuple([z.object({ connection_id: z.uuid(), claim_token: z.uuid().nullable() })]).parse(prepared.data)[0]
      const admin = service(config)
      let failureCode: ConnectionResult['failureCode']
      if (claim.claim_token) {
        const result = await admin.rpc('read_outreach_connection', { p_id: claim.connection_id, p_lease: claim.claim_token })
        checkDatabaseError(result.error)
        const scope = privateContext.safeParse(result.data)
        if (!scope.success) throw new ApiError(403)
        const key = await credential(scope.data.credential, config)
        const observation: ConnectionResult = key ? await connectAccount(scope.data, value.action, { key, fetch: config?.providerFetch, signal: request.signal }, {
          ...('password' in value ? { password: value.password, country: value.country } : {}),
          ...('pin' in value ? { pin: value.pin } : {}),
        })
          : { state: 'failed', ...(scope.data.channel === 'email' ? { failureCode: 'key_rejected' as const } : {}) }
        failureCode = observation.failureCode
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
      return json({ connectionId: saved.data.id, state: saved.data.state, expiresAt: saved.data.expires_at,
        ...(failureCode ? { failureCode } : {}),
        authUrl: saved.data.state === 'pending' && saved.data.auth_url ? googleAuthorizationUrl(saved.data.auth_url) : null })
    }),
  }
}
