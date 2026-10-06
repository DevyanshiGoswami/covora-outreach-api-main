import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { leadLinkedInUrl } from './outreach-sync-data'
import { buildRoleFilterCompanyAliases, roleFilterCategory, roleFilterTitle } from './lead-role-filter'
import type { Database } from './database.types'

const scopeSchema = z.object({ clientId: z.uuid(), listId: z.uuid() })
const sourceRow = z.object({
  firstName: z.string(), lastName: z.string(), title: z.string().nullable(), company: z.string().nullable(),
  location: z.string().nullable(), email: z.string().nullable(), linkedinUrl: z.string().nullable(),
  verified: z.boolean().nullable().optional(), verifiedReason: z.string().nullable().optional(),
})
type ImportedLead = Database['public']['Tables']['outreach_imported_leads']['Insert']
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const text = (value: string | null | undefined, max = 500) => (value ?? '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

function email(value: string | null) {
  const normalized = value?.trim().toLowerCase() ?? ''
  return normalized.length <= 254 && !/\p{Cc}/u.test(normalized) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null
}

/**
 * Operator-only adapter for the reviewed legacy verified-lead JSON schema.
 * This is not an upload endpoint. Its `verified` flag is documented as a past
 * LinkedIn/current-role check, never email deliverability or a fresh check.
 * Callers must pin the source file hash and independently authorize the tenant.
 * No contact values are included in validation errors or aggregate diagnostics.
 */
export function prepareLegacyLeadImport(input: unknown, scope: { clientId: string; listId: string }) {
  const target = scopeSchema.safeParse(scope)
  const parsed = z.array(sourceRow).min(1).max(100000).safeParse(input)
  if (!target.success || !parsed.success) throw new Error('Invalid lead import schema or target.')
  const rows: ImportedLead[] = []
  const seenEmails = new Set<string>(), seenProfiles = new Set<string>()
  const summary = { input: parsed.data.length, imported: 0, duplicates: 0, invalidEmail: 0, unavailableLinkedIn: 0, verifiedEmail: 0, verifiedLinkedIn: 0 }
  for (const source of parsed.data) {
    const address = email(source.email), profile = leadLinkedInUrl(source.linkedinUrl)
    // A stable identity is required. Do not discard a legitimate contact only
    // because an optional profile URL cannot pass the display-link allowlist.
    if (!address) summary.invalidEmail++
    if (!profile) summary.unavailableLinkedIn++
    if (!address && !profile) throw new Error('A lead is missing a stable contact identity.')
    const profileKey = profile?.toLowerCase()
    if ((address && seenEmails.has(address)) || (profileKey && seenProfiles.has(profileKey))) { summary.duplicates++; continue }
    if (address) seenEmails.add(address)
    if (profileKey) seenProfiles.add(profileKey)
    const sourceRowId = hash(address ? `email:${address}` : `linkedin:${profileKey}`)
    const identity = hash(`${target.data.listId}:${sourceRowId}`)
    const id = `${identity.slice(0,8)}-${identity.slice(8,12)}-5${identity.slice(13,16)}-a${identity.slice(17,20)}-${identity.slice(20,32)}`
    const company = text(source.company), title = text(source.title) || null
    const evidence = text(source.verifiedReason, 1000) || null
    const verified = profile && evidence && source.verified === true ? true : null
    if (verified) summary.verifiedLinkedIn++
    rows.push({
      id, client_id: target.data.clientId, list_id: target.data.listId, source_row_id: sourceRowId,
      first_name: text(source.firstName), last_name: text(source.lastName), company, job_title: title,
      location: text(source.location) || null, email: address, email_verification: 'unknown', email_verification_evidence: null,
      linkedin_url: profile, linkedin_verified: verified,
      linkedin_verification_evidence: verified ? `Imported prior source check: ${evidence}`.slice(0,1000) : null,
      role_category: title ? roleFilterCategory(roleFilterTitle(title, buildRoleFilterCompanyAliases([company]))) : null,
      status: 'not_contacted',
    })
  }
  summary.imported = rows.length
  return { rows, summary }
}
