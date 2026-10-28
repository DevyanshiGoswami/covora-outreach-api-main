import 'server-only'

/** A separate product destination must be configured explicitly, never inferred from APP_URL. */
export function outreachPortalOrigin(value: unknown): string | null {
  // Reject malformed input before URL normalization can discard it.
  if (typeof value !== 'string' || !/^https:\/\/[^\s/?#\\@]+\/?$/i.test(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}
