import { z } from 'zod'

/** Only the two authentication cookies cross the provider boundary. */
const sessionCookie = z.strictObject({
  name: z.enum(['li_at', 'JSESSIONID']), value: z.string().min(1).max(2048).regex(/^[\x21-\x7e]+$/),
  domain: z.enum(['.linkedin.com', 'linkedin.com', 'www.linkedin.com', '.www.linkedin.com']), path: z.literal('/'),
})
export const linkedinCookies = z.array(sessionCookie).length(2).refine(rows => new Set(rows.map(row => row.name)).size === 2)
export type LinkedInCookie = z.infer<typeof sessionCookie>

export function linkedinProfileUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || url.port || url.username || url.password
    || !/^\/in\/[a-zA-Z0-9_%.-]+\/?$/.test(url.pathname) || url.pathname.length > 250) throw new Error('Invalid profile')
  return `https://www.linkedin.com${url.pathname.replace(/\/$/, '').toLowerCase()}`
}
export const linkedinProfile = z.string().max(500).transform((value, ctx) => {
  try { return linkedinProfileUrl(value) } catch { ctx.addIssue({ code: 'custom', message: 'Invalid LinkedIn profile URL' }); return z.NEVER }
})
