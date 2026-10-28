// Role grouping extracted from the read-only content portal; no data or access rules copied.
function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function addAlias(aliases: Set<string>, value: string) {
  const alias = value.trim().replace(/\s+/g, ' ')
  if (alias.length >= 3) aliases.add(alias)
}

export const ROLE_FILTER_OPTIONS = [
  { value: 'owners-executives', label: 'Owners & Executives' },
  { value: 'vp-director', label: 'VP / Head / Director' },
  { value: 'manager-other', label: 'Manager / Other' },
] as const

export type RoleFilterCategory = (typeof ROLE_FILTER_OPTIONS)[number]['value']

/**
 * Builds conservative organization aliases from the imported company column.
 * Deal-list qualifiers such as "- 1300 tower sites" are intentionally excluded.
 */
export function buildRoleFilterCompanyAliases(companies: Iterable<string>): string[] {
  const aliases = new Set<string>()

  for (const company of companies) {
    const normalized = company.trim().replace(/\s+/g, ' ')
    if (!normalized) continue

    addAlias(aliases, normalized)

    const withoutParenthetical = normalized.replace(/\s*\([^)]*\)\s*$/, '').trim()
    addAlias(aliases, withoutParenthetical)

    const beforeDealQualifier = withoutParenthetical.split(/\s+(?:-|–|—)\s+/)[0]?.trim() ?? ''
    addAlias(aliases, beforeDealQualifier)

    const beforeAssetCount = beforeDealQualifier
      .replace(/\s+\d[\d,]*\s+.*$/, '')
      .replace(/\s+(?:certain|remaining)\s+.*$/i, '')
      .trim()
    addAlias(aliases, beforeAssetCount)
  }

  return [...aliases].sort((left, right) => right.length - left.length || left.localeCompare(right))
}

/**
 * Removes known company wording from an imported title for role filtering only.
 * The original title remains untouched everywhere else in the lead record.
 */
export function roleFilterTitle(title: string, companyAliases: readonly string[]): string {
  let role = title.trim()

  for (const alias of companyAliases) {
    const companyPattern = new RegExp(
      `(?:\\b(?:at|for|with)\\s+)?${escapeRegExp(alias)}`,
      'gi',
    )
    role = role.replace(companyPattern, '')
  }

  role = role
    .replace(/\s+\b(?:at|for|with)\b\s+.+$/i, '')
    .replace(/,\s*[A-Z][A-Z0-9&.'-]{2,11}\s*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;:])/g, '$1')
    .replace(/(?:\s+\b(?:at|for|with)\b|[\s,;:|/–—-])+$/i, '')
    .replace(/^[\s,;:|/–—-]+/, '')
    .trim()

  return role || title.trim()
}

/**
 * Collapses imported job-title variants into the smallest useful leadership
 * groups while preserving the original title for display and free-text search.
 */
export function roleFilterCategory(title: string): RoleFilterCategory {
  const role = title.trim().toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ')
  const acronymNormalizedRole = role.replace(/\./g, '')

  if (
    /^executive (?:administration|assistant)\b/.test(role) ||
    /\b(?:product|process(?: area)?|platform|service|system|portfolio|program)\s*,?\s*owner\b/.test(
      role,
    ) ||
    /^head (?:chef|custodian|hunter|technician)\b/.test(role) ||
    /\bchief (?:petty|warrant|staff) officer\b/.test(role) ||
    /^(?:advisor|adviser)\b/.test(role) ||
    /\b(?:advisor|adviser|counsel|manager|analyst|scientist)\b.*\b(?:to|for)\b.*\b(?:chief|chairman|president|ceo|cfo|coo|cto|cio|cmo|cro|cpo|chro|ciso|cdo|cco)\b/.test(
      acronymNormalizedRole,
    ) ||
    /\b(?:manager|analyst|scientist)\b.*\boffice of(?: the)?\b.*\b(?:chief|ceo|cfo|coo|cto|cio|cmo|cro|cpo|chro|ciso|cdo|cco)\b/.test(
      acronymNormalizedRole,
    )
  ) {
    return 'manager-other'
  }

  if (
    /^head\b.*\boffice of(?: the)?\b.*\b(?:chief|ceo|cfo|coo|cto|cio|cmo|cro|cpo|chro|ciso|cdo|cco)\b/.test(
      acronymNormalizedRole,
    )
  ) {
    return 'vp-director'
  }

  if (
    /\b(?:owner|founder|co-founder)\b/.test(role) ||
    /\b(?:chief|ceo\d*|cfo|coo|cto|cio|cmo|cro|cpo|chro|ciso|cdo|cco|cao|cso)\b/.test(
      acronymNormalizedRole,
    ) ||
    /^pdg\b/.test(role) ||
    /\b(?:chairman|chairwoman|chairperson|board member|principal|proprietor|shareholder|entrepreneur)\b/.test(
      role,
    ) ||
    /\bexecutive (?:chair|director|head|management|officer)\b/.test(role) ||
    /\b(?:finance|information technology|medical|operations|technology & operations|region|higher) executive\b/.test(
      role,
    )
  ) {
    return 'owners-executives'
  }

  if (
    /\b(?:executive vice president|senior vice president|assistant vice president|associate vice president|vice president|vice présidente|evp|svp|avp|rvp|vp|head|director)\b/.test(
      acronymNormalizedRole,
    )
  ) {
    return 'vp-director'
  }

  if (
    /\bpresident\b/.test(role) ||
    /^(?:managing|founding|general|equity|operating|senior) partner(?:\s*(?:$|[,/&-]))/.test(role) ||
    /^partner(?:\s*(?:$|[,/&-]))/.test(role) ||
    /\b(?:general manager|president)\s*(?:,|and|&)\s*partner\b/.test(role)
  ) {
    return 'owners-executives'
  }

  return 'manager-other'
}
