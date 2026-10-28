# Client removal

## Symptom
Agency owners could create a client but could not remove it from the portal.

## Root cause
Deleting the client row would cascade through outreach history. Disabling only a UI card would leave team invitations and queued operations usable.

## Approach that worked
Migration 0113 adds an authenticated owner-only removal RPC. It verifies the exact current company name and locks the client before authority, following the team/connection/dispatch order. The transaction disables the outreach feature and account/reply workspaces, revokes client memberships and pending invitations, cancels undispatched replies, and records one removal audit event. Retry after a lost response is idempotent. Active dispatch blocks removal; expired dispatch retains an uncertain outcome. Existing uncertain commands and account reservations remain intact.

Auth users, agency roles, other client memberships, provider credentials, correspondence and provider assignments are retained. No provider calls occur. External campaigns must be stopped separately; this feature does not claim to stop them. There is no automatic restore or permanent-delete UI.

## Rule for next time
Workspace removal must use the tenant feature gate and current database authority, not a browser-only permission check. Preserve sender reservations and uncertain send history. Treat external campaign shutdown and permanent data erasure as separate, explicitly scoped operations.

## Evidence
New isolated local stack initialized through 0113. All 137 database tests passed, including denied client roles, revoked owners, exact-name confirmation, invitation revocation, other-client access, queued/preparing reply cancellation, active dispatch refusal, retained uncertain history and idempotency. A focused rerun additionally verified that an OAuth attempt begun before removal cannot finalize and its reservation remains. API unit tests verify bearer binding, malformed input rejection and safe error mapping. Unit/tooling, lint, types, build and runtime dependency audit passed. Browser verification covers the companion portal flow; no production customer is removed for testing.
