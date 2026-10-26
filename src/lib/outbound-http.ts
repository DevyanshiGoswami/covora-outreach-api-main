import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { resolveDeveloperSession, type DeveloperConfig } from './developer-session'
import { authorizeDevelopmentRequest, scopeDevelopmentResponse } from './developer-scope'
import { requireRuntimeDatabase } from './runtime-config'

export type OutboundApiConfig = { url: string; anonKey: string; fetch: typeof fetch; timeoutMs?: number; development?: DeveloperConfig }
type ErrorStatus = 400 | 401 | 403 | 500
const MAX_BODY_BYTES = 8192
export class ApiError extends Error {
  constructor(readonly status: ErrorStatus) { super() }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', Vary: 'Authorization' } })
}

export function checkDatabaseError(error: { code: string } | null): void {
  if (!error) return
  if (error.code === '42501') throw new ApiError(403)
  if (error.code === '22023' || error.code === '22P02') throw new ApiError(400)
  if (error.code === 'PGRST301' || error.code === 'PGRST302') throw new ApiError(401)
  throw new ApiError(500)
}

/** Bounded even for chunked bodies; individual endpoints may allow larger text. */
export async function readJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(400)
  }
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw new ApiError(400)
  }
  if (!request.body) throw new ApiError(400)
  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let body = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        // A cloned request uses a tee; waiting for cancel can deadlock until
        // the untouched branch is consumed. Cancellation must not delay refusal.
        void reader.cancel().catch(() => {})
        throw new ApiError(400)
      }
      body += decoder.decode(value, { stream: true })
    }
    return JSON.parse(body + decoder.decode()) as unknown
  } catch {
    throw new ApiError(400)
  } finally {
    reader.releaseLock()
  }
}

/** Verify each bearer and bind all database calls to that same user JWT. */
export function createOutboundHandler(config: OutboundApiConfig | undefined, messages: Record<ErrorStatus, string>) {
  async function authenticate(request: Request): Promise<SupabaseClient<Database>> {
    const token = request.headers.get('authorization')?.match(/^Bearer[\t ]+([^\s,]+)[\t ]*$/i)?.[1]
    if (!token || token.length > 16384) throw new ApiError(401)
    const runtime = config ? null : requireRuntimeDatabase()
    const url = config?.url ?? runtime?.url
    const anonKey = config?.anonKey ?? runtime?.anonKey
    if (!url || !anonKey) throw new ApiError(500)
    const fetchImpl = config?.fetch ?? fetch
    const deadline = AbortSignal.timeout(config?.timeoutMs ?? 8000)
    const client = createClient<Database>(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        headers: { Authorization: `Bearer ${token}` },
        fetch: async (input, init) => {
          try {
            const signals = [deadline, request.signal]
            if (init?.signal) signals.push(init.signal)
            if (input instanceof Request) signals.push(input.signal)
            const signal = AbortSignal.any(signals)
            signal.throwIfAborted()
            return await fetchImpl(input, { ...init, signal, cache: 'no-store', redirect: 'error' })
          } catch {
            // Auth's SDK logs thrown fetch errors; keep transport diagnostics out of that path.
            return Response.json({ message: 'Request unavailable.' }, { status: 503 })
          }
        },
      },
    })
    const { data, error } = await client.auth.getUser(token)
    if (error) throw new ApiError(error.status === undefined || error.status >= 500 || error.status === 0 ? 500 : 401)
    if (!data.user) throw new ApiError(401)
    return client
  }

  return function handle(operation: (request: Request, client: SupabaseClient<Database>) => Promise<Response>) {
    return async (request: Request): Promise<Response> => {
      try {
        const token = request.headers.get('authorization')?.match(/^Bearer[\t ]+([^\s,]+)[\t ]*$/i)?.[1]
        if (token?.startsWith('cdev_')) {
          const scope = await resolveDeveloperSession(token, config)
          await authorizeDevelopmentRequest(request, scope, config)
          const headers = new Headers(request.headers)
          headers.set('authorization', `Bearer ${scope.bearer}`)
          const delegated = new Request(request, { headers })
          const response = await operation(delegated, await authenticate(delegated))
          return await scopeDevelopmentResponse(delegated, response, scope)
        }
        return await operation(request, await authenticate(request))
      } catch (error) {
        const status = error instanceof ApiError ? error.status : 500
        return json({ error: messages[status] }, status)
      }
    }
  }

}
