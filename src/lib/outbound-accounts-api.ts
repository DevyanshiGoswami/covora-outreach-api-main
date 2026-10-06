import 'server-only'
import { requireRuntimeDatabase } from './runtime-config'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from './database.types'
import { verifyScopedInstantlyAccount, type ScopedAccountObservation } from './instantly'
import { ApiError, checkDatabaseError, createOutboundHandler, json, readJson, type OutboundApiConfig } from './outbound-http'

export type OutboundAccountApiConfig = OutboundApiConfig & {
  serviceKey?: string
  credentials?: Readonly<Record<string, string | undefined>>
  providerFetch?: typeof fetch
  providerTimeoutMs?: number
}
const uuid = z.uuid()
const email = z.string().trim().toLowerCase().pipe(z.email().max(254))
const displayName = z.string().refine((value) => [...value].length <= 100)
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)))
const state = z.enum(['unverified', 'connected', 'paused', 'maintenance', 'setting_up', 'needs_attention'])
const accountSchema = z.object({
  id: uuid, client_id: uuid, channel: z.literal('email'), email, display_name: displayName, state,
  last_checked_at: timestamp.nullable(), last_attempt_at: timestamp.nullable(), last_connected_at: timestamp.nullable(),
  check_error: z.boolean(), updated_at: timestamp,
})
export type OutboundAccount = z.infer<typeof accountSchema>
const registerSchema = z.strictObject({ clientId: uuid, email, displayName })
const verifySchema = z.strictObject({ clientId: uuid, accountId: uuid })
const workspaceConfigSchema = z.object({ client_id: uuid, credential_ref: z.string(), enabled: z.boolean() })
const checkSchema = z.tuple([z.object({
  account_id: uuid, client_id: uuid, email, remote_workspace_id: uuid, credential_ref: z.string(),
})])
const PAGE_SIZE = 500
const MAX_ACCOUNTS = 5000

async function input<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (new URL(request.url).search) throw new ApiError(400)
  const value = schema.safeParse(await readJson(request))
  if (!value.success) throw new ApiError(400)
  return value.data
}

/** Only dedicated environment references are supported; a missing key is never replaced by the legacy key. */
function credential(ref: string, config?: OutboundAccountApiConfig): string | undefined {
  if (!/^OUTREACH_INSTANTLY_[A-Z0-9_]+$/.test(ref)) return undefined
  return (config?.credentials ?? process.env)[ref]?.trim() || undefined
}

/** Called only after the user-scoped workspace query or begin RPC authorizes the requested scope. */
function serviceClient(request: Request, config?: OutboundAccountApiConfig) {
  const runtime = config ? null : requireRuntimeDatabase(true)
  const url = config?.url ?? runtime?.url
  const key = config?.serviceKey ?? runtime?.serviceKey
  if (!url || !key) throw new ApiError(500)
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input, init) => {
        try {
          // Each private RPC remains bounded, including finalization after the separate provider deadline.
          const signals = [AbortSignal.timeout(Math.max(1, Math.min(config?.timeoutMs ?? 8000, 8000))), request.signal]
          if (init?.signal) signals.push(init.signal)
          if (input instanceof Request) signals.push(input.signal)
          const signal = AbortSignal.any(signals)
          signal.throwIfAborted()
          return await (config?.fetch ?? fetch)(input, { ...init, signal, cache: 'no-store', redirect: 'error' })
        } catch {
          return Response.json({ message: 'Request unavailable.' }, { status: 503 })
        }
      },
    },
  })
}

export function createOutboundAccountHandlers(config?: OutboundAccountApiConfig) {
  const handle = createOutboundHandler(config, {
    400: 'Invalid account request. Refresh and try again.',
    401: 'Sign in to continue.',
    403: 'This account request is unavailable for your account.',
    500: 'Unable to complete the account request. Please try again.',
  })
  return {
    GET: handle(async (request, client) => {
      const query = [...new URL(request.url).searchParams]
      if (query.length !== 1 || query[0][0] !== 'clientId') throw new ApiError(400)
      const clientId = uuid.safeParse(query[0][1])
      if (!clientId.success) throw new ApiError(400)
      const workspace = await client.from('client_outreach_workspaces')
        .select('client_id').eq('client_id', clientId.data).maybeSingle()
      checkDatabaseError(workspace.error)
      if (!workspace.data || workspace.data.client_id !== clientId.data) throw new ApiError(403)
      const accounts: OutboundAccount[] = []
      // The user client's shared deadline bounds pagination; partial lists are never returned as complete.
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const result = await client.from('client_outreach_accounts')
          .select('id,client_id,channel,email,display_name,state,last_checked_at,last_attempt_at,last_connected_at,check_error,updated_at')
          .eq('client_id', clientId.data).order('email').order('id').range(offset, offset + PAGE_SIZE - 1)
        checkDatabaseError(result.error)
        const parsed = z.array(accountSchema).safeParse(result.data)
        if (!parsed.success || parsed.data.some((account) => account.client_id !== clientId.data)
          || accounts.length + parsed.data.length > MAX_ACCOUNTS) throw new ApiError(500)
        accounts.push(...parsed.data)
        if (parsed.data.length < PAGE_SIZE) break
      }
      const configured = await serviceClient(request, config).from('outreach_account_workspaces')
        .select('client_id,credential_ref,enabled').eq('client_id', clientId.data).maybeSingle()
      checkDatabaseError(configured.error)
      let verificationAvailable = false
      if (configured.data) {
        const parsed = workspaceConfigSchema.safeParse(configured.data)
        if (!parsed.success || parsed.data.client_id !== clientId.data) throw new ApiError(500)
        verificationAvailable = parsed.data.enabled && Boolean(credential(parsed.data.credential_ref, config))
      }
      return json({ accounts, verificationAvailable })
    }),
    POST: handle(async (request, client) => {
      const value = await input(request, registerSchema)
      const result = await client.rpc('register_outreach_account', {
        p_client_id: value.clientId, p_email: value.email, p_display_name: value.displayName,
      })
      checkDatabaseError(result.error)
      const accountId = uuid.safeParse(result.data)
      if (!accountId.success) throw new ApiError(500)
      return json({ accountId: accountId.data })
    }),
    verify: handle(async (request, client) => {
      const value = await input(request, verifySchema)
      const begun = await client.rpc('begin_outreach_account_check', { p_client_id: value.clientId, p_account_id: value.accountId })
      checkDatabaseError(begun.error)
      const checkId = uuid.safeParse(begun.data)
      if (!checkId.success) throw new ApiError(500)
      const admin = serviceClient(request, config)
      const context = await admin.rpc('read_outreach_account_check', { p_check_id: checkId.data })
      checkDatabaseError(context.error)
      const parsed = checkSchema.safeParse(context.data)
      if (!parsed.success || parsed.data[0].client_id !== value.clientId || parsed.data[0].account_id !== value.accountId) throw new ApiError(500)
      const check = parsed.data[0]
      const key = credential(check.credential_ref, config)
      const observation: ScopedAccountObservation = key
        ? await verifyScopedInstantlyAccount(check.email, {
          apiKey: key, expectedWorkspaceId: check.remote_workspace_id,
          fetch: config?.providerFetch, timeoutMs: config?.providerTimeoutMs, signal: request.signal,
        })
        : { state: null, error: 'check_unavailable' }
      const finished = await admin.rpc('finish_outreach_account_check', {
        p_check_id: checkId.data,
        ...(observation.state === null ? { p_error_code: observation.error } : { p_state: observation.state }),
      })
      checkDatabaseError(finished.error)
      if (finished.data !== true) throw new ApiError(403)
      return json({ ok: true })
    }),
  }
}
