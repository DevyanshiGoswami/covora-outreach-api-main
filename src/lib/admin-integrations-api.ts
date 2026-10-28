import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from './database.types'
import { ApiError, checkDatabaseError, createOutboundHandler, json, readJson, type OutboundApiConfig } from './outbound-http'
import { requireRuntimeDatabase } from './runtime-config'
import { checkConnectionWorkspace, discoverEmailWorkspace, verifyConnectionWorkspace } from './onboarding-provider'
import { resolveIntegrationCredential } from './integration-credentials'
import { createProviderCallLogger } from './provider-call-log'
import { portalContextSchema } from './onboarding-contract'

export type AdminIntegrationConfig = OutboundApiConfig & { serviceKey: string; providerFetch?: typeof fetch }
const inputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('save'), id: z.uuid(), version: z.number().int().nonnegative(), channel: z.enum(['email','linkedin']),
    label: z.string().trim().min(1).max(100), apiKey: z.string().trim().min(8).max(4096).regex(/^[^\s]+$/), workspaceId: z.string().trim().max(200).optional() }),
  z.strictObject({ action: z.enum(['check','remove']), id: z.uuid(), version: z.number().int().positive() }),
])
function service(config?: AdminIntegrationConfig) {
  const runtime = config ?? requireRuntimeDatabase(true)
  if (!runtime.serviceKey) throw new ApiError(500)
  return createClient<Database>(runtime.url, runtime.serviceKey, { auth: { persistSession: false, autoRefreshToken: false }, global: {
    fetch: async (input, init) => {
      try { return await (config?.fetch ?? fetch)(input, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000) }) }
      catch { return Response.json({ message: 'Request unavailable' }, { status: 503 }) }
    },
  } })
}
async function owner(client: SupabaseClient<Database>, admin: SupabaseClient<Database>) {
  const result = await client.rpc('outreach_portal_context'); checkDatabaseError(result.error)
  const actor = portalContextSchema.parse(result.data)
  if (!actor.isOwner) throw new ApiError(403)
  const membership = await admin.from('outreach_agency_memberships').select('version').eq('user_id', actor.userId).eq('state','active').single()
  checkDatabaseError(membership.error)
  if (!membership.data) throw new ApiError(403)
  return { p_actor: actor.userId, p_actor_version: membership.data.version }
}
export function createAdminIntegrationHandlers(config?: AdminIntegrationConfig) {
  const handle = createOutboundHandler(config, { 400: 'Check the details. The connection may be assigned, changed, or already configured.', 401: 'Sign in to continue.',
    403: 'Only agency owners can configure integrations.', 500: 'Integration changes could not be confirmed. Refresh before trying again.' })
  return {
    GET: handle(async (request, client) => {
      if (new URL(request.url).search) throw new ApiError(400)
      const admin = service(config); await owner(client, admin)
      const result = await admin.from('outreach_integrations').select('id,channel,label,version,verified_at,checked_at,check_error,credential_ref').order('label').order('id').limit(101)
      checkDatabaseError(result.error)
      if (!result.data || result.data.length>100) throw new ApiError(500)
      const [email, linkedin] = await Promise.all([
        admin.from('outreach_account_workspaces').select('credential_ref'), admin.from('outreach_reply_workspaces').select('credential_ref'),
      ])
      checkDatabaseError(email.error); checkDatabaseError(linkedin.error)
      return json({ integrations: result.data.map(row => ({ id: row.id, channel: row.channel, label: row.label, version: row.version,
        verifiedAt: row.verified_at, checkedAt: row.checked_at, checkError: row.check_error,
        assigned: [...(email.data ?? []), ...(linkedin.data ?? [])].some(binding => binding.credential_ref===row.credential_ref) })) })
    }),
    POST: handle(async (request, client) => {
      if (new URL(request.url).search) throw new ApiError(400)
      const admin = service(config); const actor = await owner(client, admin)
      const parsed = inputSchema.safeParse(await readJson(request)); if (!parsed.success) throw new ApiError(400)
      const value = parsed.data
      const existing = await admin.from('outreach_integrations').select('id,channel,remote_workspace_id,credential_ref,version').eq('id',value.id).maybeSingle()
      checkDatabaseError(existing.error)
      if ((existing.data?.version ?? 0) !== value.version) throw new ApiError(400)
      if (value.action === 'save') {
        if (existing.data && existing.data.channel !== value.channel) throw new ApiError(400)
        const options = { key: value.apiKey, fetch: config?.providerFetch, signal: request.signal,
          log: createProviderCallLogger(admin, { source: 'integration_check', integrationId: value.id }) }
        const workspace = value.channel === 'email' ? await discoverEmailWorkspace(options) : existing.data?.remote_workspace_id ?? value.workspaceId
        if (!workspace || (existing.data && existing.data.remote_workspace_id !== workspace)) {
          return json({ code: 'key_verification_failed', error: 'The API key could not be verified for this workspace. Check its permissions and try again.' }, 400)
        }
        if (value.channel === 'linkedin') {
          const verification = await verifyConnectionWorkspace('linkedin', workspace, options)
          if (!verification.ok) return json({ code: verification.code ?? 'key_verification_failed', error: 'The service could not verify this API key.' }, 400)
        }
        const saved = await admin.rpc('save_outreach_integration', { ...actor, p_id:value.id,p_version:value.version,p_channel:value.channel,p_label:value.label,p_workspace:workspace,p_key:value.apiKey })
        if (saved.error) console.warn('Integration save rejected', { code: saved.error.code })
        checkDatabaseError(saved.error)
        return json({ ok:true })
      }
      if (!existing.data) throw new ApiError(400)
      if (value.action === 'remove') {
        const removed = await admin.rpc('remove_outreach_integration', { ...actor,p_id:value.id,p_version:value.version }); checkDatabaseError(removed.error)
        return json({ ok:true })
      }
      const key = await resolveIntegrationCredential(existing.data.credential_ref, {}, admin)
      const ok = Boolean(key && await checkConnectionWorkspace(existing.data.channel as 'email'|'linkedin', existing.data.remote_workspace_id, { key, fetch:config?.providerFetch,signal:request.signal,
        log: createProviderCallLogger(admin, { source: 'integration_check', integrationId: value.id }) }))
      const checked = await admin.rpc('check_outreach_integration', { ...actor,p_id:value.id,p_version:value.version,p_ok:ok }); checkDatabaseError(checked.error)
      return json({ ok:true, verified:ok })
    }),
  }
}
