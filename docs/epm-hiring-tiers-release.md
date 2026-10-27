# EPM hiring partner company tiers

## Scope

This release exposes EPM's recorded company segment as Tier 1, Tier 2, Tier 3,
or unassigned. The tier filter applies before pagination and combines with the
existing audience, campaign plan, location and contact filters. It does not change
priority rankings, qualification, campaign membership, escrow or outreach state.

Only exact `companyFit.assessedTier` values 1, 2 or 3 are projected. An explicit
`hiringTierReview` with `status: reviewed` and an exact tier takes precedence.
Other fields and missing evidence never infer a company segment. No contact data
is copied into this repository. Separately reviewed data classification is outside
the schema/API code change.

## Targets and ordering

The dedicated outbound API is `covora-outreach-api`; its frontend is
`covora-outreach` at `covora.app`. The content product at `app.covora.app` is not a
target. Both projects remain in the existing hosting team.

1. Recheck current main and the outbound database migration ledger. The prepared
   backend base is `36e039b`; migration `0143` follows the compatible campaign sequence migration `0142`. The existing lead-directory body must still match its reviewed baseline.
2. Apply `0143_outreach_lead_hiring_tiers.sql` to the dedicated outbound database.
   It replaces the directory RPC with a defaulted tier argument and retains the
   existing access checks/grants. It does not mutate lead rows or provider settings.
3. Deploy the backend and verify health, an authorized EPM Hiring Partners read
   for each tier and the unassigned bucket, denied reads, and unaffected athletes.
4. Deploy the frontend companion change only after the API accepts `tier`.
5. Verify the live Hiring Partners dropdown, badges, pagination and CSV export.
   Keep Best fit first independent from the company segment.

If code rollback is needed, revert the frontend first, then the API. The RPC's
defaulted `p_tier` remains compatible with the previous API; keep the additive
database projection instead of dropping it during a code rollback.

## Verification

`epm-hiring-tiers-verification.json` records isolated database, API and build
checks. Fifty-seven affected database regressions and eleven focused API tests
passed. Frontend verification includes all 235 tests, boundary/type checks and
the production build, plus a development-only browser fixture.

Two unrelated pre-existing backend tests fail locally: comments Unicode
author-name length and onboarding expiry timing. Their behavior is unchanged.
Report their CI status accurately; do not bypass an enforced merge or release
gate. No release is confirmed until the hosted checks above succeed.

The latest review projection exposes only bounded rationale, qualification gaps and public HTTPS source links. It is available only on EPM Hiring Partners and includes unresolved assessments. Internal review metadata and outreach approval fields remain private. Client copy passes through the existing neutral research boundary.

Concurrent release reconciliation: the campaign sequence release occupied version 0142 before this release. The original guarded transaction rejected that drift without schema changes. This branch preserves the merged sequence work and moves only the tier migration to 0143; the new production guard requires the exact reviewed sequence migration and the unchanged lead-directory body.
