# Campaign and lead read latency

## Symptom

Campaign navigation, detail screens and their inner tabs were slow. Production
statement statistics recorded the lead projection averaging 5,988 ms across two
calls, with a 7,186 ms maximum. A read-only authenticated query for 500 rows took
4,120 ms and materialized 16,687 authorized leads before the outer client filter.

## Root cause

The campaign, daily activity, step and lead functions still called `can_read`
for each row. Migration 0115 fixed the message projection only. Pagination in the
frontend repeated the expensive lead scan for each 500-row page.

## Approach that worked

Migration 0116 uses the same statement-local, materialized authorized-workspace
list for all four campaign readers. Joins retain the existing email campaign and
client pairing. The current identity, active membership/owner and feature gates
remain in the existing workspace authority. Projections, analytics availability,
private fields, execute grants and view security flags are unchanged.

## Rule for next time

Audit related readers when fixing an expensive per-row access check. Verify both
the query plan and complete output equality, and test revoked access using the
same session. Do not substitute cross-request permission caches for authorization.

## Evidence

- Isolated 17,000-lead benchmark: the same authenticated neutral-view count took
  3,707 ms before and 8.7 ms after. Full projected-row hashes and counts matched.
  Both definitions and the synthetic fixture were inside a rolled-back transaction.
- All 144 database tests passed, including new role, owner deduplication,
  cross-tenant, feature-disabled, revoked/suspended, anonymous, channel and
  private-field checks across all four readers.
- 288 unit tests and six tooling tests passed. Lint, types, full dependency audit
  and production build passed. Generated public types did not change.
- A local production frontend build was tested against this isolated database:
  campaign list, details, all four tabs and 600-lead completeness/search passed.

## Limits and release verification

The functions still materialize authorized rows before outer filters, so very
large datasets may eventually need parameterized or paged database readers.
This migration removes the measured repeated authorization cost. After release,
repeat the exact live query and compare all four projections against their old
expressions in one read-only snapshot. Query time is not full page-load time.
