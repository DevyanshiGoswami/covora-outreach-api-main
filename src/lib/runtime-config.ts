import 'server-only'

type Environment = Readonly<Record<string, string | undefined>>
const CONTENT_PORTAL_PROJECT = 'stfygrdsjgrmmawvnifc'

/** Pin every production database call to the independently provisioned project.
 * Local access is restricted to this product's disposable stack, never old pilots. */
export function databaseTargetAllowed(value: unknown, projectRef: unknown, production = false): boolean {
  if (typeof value !== 'string' || typeof projectRef !== 'string' || !projectRef || projectRef === CONTENT_PORTAL_PROJECT) return false
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return false
    if (url.hostname === `${CONTENT_PORTAL_PROJECT}.supabase.co`) return false
    if (url.protocol === 'https:' && !url.port && /^[a-z0-9]{20}$/.test(projectRef)) {
      return url.hostname === `${projectRef}.supabase.co`
    }
    return !production && projectRef === 'local-outreach'
      && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '60321'
  } catch { return false }
}

export function runtimeConfiguration(env: Environment = process.env) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  return {
    url, anonKey, serviceKey,
    databaseTargetValid: databaseTargetAllowed(url, env.OUTREACH_SUPABASE_PROJECT_REF, env.NODE_ENV === 'production'),
    publicCredentialConfigured: Boolean(anonKey), serviceCredentialConfigured: Boolean(serviceKey),
    repliesEnabled: env.OUTREACH_REPLIES_ENABLED === 'true',
    syncEnabled: env.OUTREACH_SYNC_ENABLED === 'true',
    alertsEnabled: env.ENABLE_OUTREACH_LEAD_ALERT_EMAILS === 'true',
  }
}

export function requireRuntimeDatabase(privileged = false) {
  const config = runtimeConfiguration()
  if (!config.databaseTargetValid || !config.url || !config.anonKey || (privileged && !config.serviceKey)) {
    throw new Error('Outreach configuration unavailable')
  }
  return { url: config.url, anonKey: config.anonKey, serviceKey: config.serviceKey }
}

export function repliesEnabled(override?: boolean): boolean {
  return override ?? runtimeConfiguration().repliesEnabled
}
