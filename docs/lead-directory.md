# Outbound lead directory

`GET /api/outbound/leads` exposes a dedicated, neutral directory of campaign leads already assigned to the authenticated client's outbound workspace. It never reads the content portal database or discovers/imports unrelated provider lists. Existing results views and contracts stay unchanged.

The bearer is verified on every request. A single authenticated RPC checks the current product feature and active membership (including viewers or explicitly provisioned agency ownership) before reading any data. Base tables remain denied to browser roles. The RPC returns no provider identifiers, raw payloads or credentials; all rows, counts and filter options share one tenant-scoped snapshot.

The directory returns 36 leads per page, literal case-insensitive search, AND-composed role/company/campaign/email/LinkedIn/status filters, deterministic company/name/role sorting, filtered totals and workspace-wide summary counts. Excessive valid page numbers clamp to the last page. Company options are bounded to 1,000 and campaign options to 500, with the currently selected authorized option retained beyond the cap. `filterOptionsTruncated` reports either cap; search and counts still cover the entire workspace.

## Metadata and evidence

Migration `0101_outreach_lead_directory.sql` adds nullable title, location, canonical LinkedIn URL and role grouping; email verification defaults to `unknown`, and LinkedIn verification stays nullable. Existing leads receive no invented verification evidence. The existing campaign sync updates these fields as each campaign's lead scan runs; a release operator can restart only the authorized campaigns' lead scans under the existing durable worker lease if a faster backfill is needed.

The worker explicitly allows native `job_title` and native `verification_status`, plus known custom profile aliases for first/last names, company, job title, location and LinkedIn URL. It drops arbitrary payload fields. Native verification code `1` maps to `verified`; `-1/-2/-3/-4` map to `unverified`; pending, missing, strings and unknown values remain `unknown`. Custom verification booleans are never trusted. No currently supported field proves LinkedIn verification, so a valid URL means available, not verified. This mapping follows the [official Lead schema](https://developer.instantly.ai/api-reference/schemas/lead), checked October 5, 2026. The [list endpoint](https://developer.instantly.ai/api-reference/lead/list-leads) supplies the existing campaign-scoped read pages; no verification purchase or enrichment request is made.

Only `http/https` individual LinkedIn `/in/<slug>` links on the exact LinkedIn host (including its www/country variant) normalize to `https://www.linkedin.com/in/<slug>`. Credentials, nonstandard ports, alternate paths, unsafe protocols and foreign hosts are rejected; query/hash tracking is dropped. Profile fields are plain text with control characters removed, whitespace normalized and length bounded. The SQL projection also normalizes historical display cells and global facets, so a malformed old field does not poison unrelated pages. Invalid or overlong historical email addresses project as unavailable with unknown verification and do not count as available/verified.

Role grouping was extracted from the read-only content portal's tested title classifier. Known company wording is removed for classification only; the original job title remains visible. Missing titles are not invented and fall within the broad Manager / Other filter.

## Verification and limits

API tests cover bearer verification, same-JWT RPC binding, strict filters, provider-free projection, tenant mismatches, bounded pagination, failures and honest empty states. Database tests cover positive viewer access, other-tenant/anonymous/unassigned/revoked/feature-disabled denial, denied raw tables and mutations, retained legacy contracts, combined search/filters, pagination, bounded facets, dirty historical text, email and URL evidence. Mapper tests exercise native verification semantics, safe links, malicious/custom payload flags and conservative roles.

Local fixtures use only the isolated `Covora_Outreach_API` stack, API 60321 / database 60322. These checks do not prove live credentials, cloud migrations, provider field availability or frontend deployment. Those release checks must target the independent outbound resources only. The old `app.covora.app` portal remains a read-only reference.
