# Slow dashboard and agency refreshes

## Symptom

Production navigation into Agency and refreshes were slow. Public login and API
health probes responded in 0.1–0.3 seconds. Production statement statistics showed
message-count queries averaging 3,298 ms (313 calls) and 5,745 ms (47 calls), with
maxima near 7,900 ms. These are historical query timings, not page-load timings.

## Root cause

The dashboard unread badge and agency received-email totals query the neutral
message view. Its security-definer function evaluated `can_read(client_id)` for
every message. The function also prevents the caller's client/direction filters
from being pushed into the base-table scan. An owner count returning 11 unread
messages materialized 4,974 authorized messages, taking 1,293 ms in a production
EXPLAIN and touching 21,093 shared buffers.

## Approach that worked

Migration 0115 materializes the existing `read_workspaces()` authorization result
once per statement and joins message rows to those authorized workspace IDs.
The current user's identity, active owner/membership checks, enabled feature gate,
email campaign assignment, column projection, function grants and public view
security flags are preserved. There is no cross-request or cross-user cache.
No frontend change, new index, new hosting service or capacity upgrade is needed.

## Rule for next time

Measure production query statistics and execution plans before changing hosts or
adding caches. Avoid repeated tenant authorization inside a large row scan. Keep
authorization based on the existing workspace authority and test revocation with
the same session immediately after membership/feature changes.

## Evidence

- A read-only production candidate plan processed the same 4,974 authorized rows
  in 7.8 ms. This is a diagnostic plan, not an end-to-end production measurement.
- An isolated local database containing 5,000 synthetic messages ran the exact
  public-view count under the authenticated role: 390.2 ms before, 8.7 ms after.
  Full projected-row hashes and row counts matched. Fixture creation and both
  function definitions were enclosed in a transaction that rolled back.
- New database tests cover all four client roles, owners with overlapping client
  memberships, exact unread counts, cross-tenant denial, anonymous denial, private
  columns/base tables, disabled features, and suspended/revoked memberships.
- Existing database regression suite: 140 tests passed. Both new tests passed
  after correcting the fixture to expect rejection of non-email messages at the
  existing write boundary. CI reruns the combined suite from a fresh database.
- 288 unit tests and six tooling tests passed; lint, typecheck, production build
  and runtime dependency audit passed. Generated public types are unchanged.

## Limits

The function still materializes authorized message rows, including bodies, before
outer count filters. At larger volumes, a dedicated tenant-authorized aggregate
read would avoid this remaining work. This change removes the measured repeated
authorization cost without altering the current frontend contract. Database
timings do not include network/authentication/rendering time; verify live timings
after migration and ask the user to retry the affected signed-in screens.
