import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

/**
 * One provider HTTP call, recorded so connection failures can be diagnosed later.
 * Never contains keys, cookies, passwords, PINs, request bodies or raw identifiers.
 */
export type ProviderCallEntry = {
  channel: 'email' | 'linkedin'
  method: 'GET' | 'POST'
  /** Path with emails, UUIDs and numeric IDs replaced by placeholders. */
  operation: string
  /** HTTP status, or null when no response arrived. */
  status: number | null
  outcome: 'ok' | 'http_error' | 'network_error' | 'timeout'
  durationMs: number
  /** First provider request/trace header found, as "name: value". */
  requestId: string | null
  /** Masked, bounded excerpt of an error response body. Null for successful calls. */
  errorExcerpt: string | null
}
export type ProviderCallContext = { source: 'connection' | 'email_review' | 'integration_check' | 'probe'; connectionId?: string | null; integrationId?: string | null }
export type ProviderCallLogger = (entry: ProviderCallEntry) => Promise<void>

const REQUEST_ID_HEADERS = ['x-request-id', 'request-id', 'x-correlation-id', 'x-amzn-requestid', 'x-amz-cf-id', 'x-trace-id', 'traceparent', 'cf-ray']
const EXCERPT_LIMIT = 400

export function normalizeProviderPath(path: string): string {
  const [pathname] = path.split('?')
  return pathname.split('/').map(segment => {
    const value = (() => { try { return decodeURIComponent(segment) } catch { return segment } })()
    if (value.includes('@')) return '{email}'
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return '{id}'
    if (/^[0-9]+$/.test(value)) return '{id}'
    return segment
  }).join('/').slice(0, 200)
}

export function providerRequestId(headers: Headers): string | null {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name)
    if (value && /^[\x20-\x7e]+$/.test(value)) return `${name}: ${value.slice(0, 160)}`
  }
  return null
}

/** Keeps the provider's explanation readable while masking anything that could be a credential or identity. */
export function redactProviderText(raw: string): string | null {
  let text = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return null
  text = text
    .replace(/"(li_at|jsessionid|password|pin|apikey|api_key|x-api-key|token|access_token|refresh_token|cookie|cookies|authorization|secret|twofactorauthkey)"\s*:\s*("(?:[^"\\]|\\.)*"|[^,}\]]+)/gi, '"$1":"[redacted]"')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[redacted]')
    .replace(/ajax:[0-9]+/gi, '[redacted]')
    .replace(/[A-Za-z0-9_\-+/=.%:]{32,}/g, '[redacted]')
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}…` : text
}

/**
 * Logs to the server console and, best effort, to outreach_provider_calls.
 * A logging failure never changes the outcome of the provider call it describes.
 */
export function createProviderCallLogger(admin: SupabaseClient<Database> | null, context: ProviderCallContext): ProviderCallLogger {
  return async entry => {
    console.info('[provider-call]', JSON.stringify({ source: context.source, connectionId: context.connectionId ?? null, integrationId: context.integrationId ?? null, ...entry }))
    if (!admin) return
    try {
      await admin.from('outreach_provider_calls').insert({
        source: context.source, connection_id: context.connectionId ?? null, integration_id: context.integrationId ?? null,
        channel: entry.channel, method: entry.method, operation: entry.operation, http_status: entry.status, outcome: entry.outcome,
        duration_ms: entry.durationMs, request_id: entry.requestId, error_excerpt: entry.errorExcerpt,
      })
    } catch { /* Diagnostics are best effort. */ }
  }
}
