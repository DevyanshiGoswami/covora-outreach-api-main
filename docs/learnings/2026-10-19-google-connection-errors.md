# Diagnose Google connection failures without disclosing secrets

## Symptom
A mailbox connection failed before a consent URL was returned. A valid saved integration could read its workspace but its Google initialization request returned 401 because accounts:create was missing.

## Root cause
Workspace authentication does not prove permission to create mailbox connections. The adapter discarded all upstream error details and returned only failed/uncertain, leaving the UI unable to distinguish an invalid credential from insufficient permissions.

## Approach that worked
Read bounded error responses only for email 401/403. Recognize a fixed scope-error prefix and emit allowlisted codes; never return raw service text. Send the transient failure code alongside the existing persisted connection state. Log only channel-independent step, action, HTTP status and fixed code. Keep workspace/mailbox checks, leases, single-attempt uncertain outcomes and LinkedIn behavior intact.

## Rule for next time
Validate the capability required by a flow, not just key validity. Permission requirements for initialization and status differ. Retain a client-safe reason for actionable errors while keeping credentials and raw service responses private.

## Evidence
289 unit and 6 tooling tests passed, including scope errors, rejected keys, rate limits, timeouts, no retries and absence of sensitive values in logs. Lint, typecheck, dependency audit (zero findings) and production build passed. Required CI database tests run on a fresh isolated stack before merge. No schema changes. Live configuration still requires a replacement key with accounts:create and review of the legacy client assignment; this change does not claim to repair external permissions.
