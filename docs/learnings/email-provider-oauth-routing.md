# Email OAuth routing

## Symptom

Email connection initiation only supported Google Workspace. Users with Microsoft mailboxes needed an equivalent route without changing tenant authorization or completion verification.

## Root cause

The initiation endpoint and consent URL validation were Google-specific; the database's stored-link check accepted only that host. The shared status endpoint already supplies the information needed for either provider.

## Approach that worked

Build on the existing Microsoft connection branch: accept an optional Google/Microsoft preference only at initiation, validate the matching authorization host/path, and extend the stored-link check with migration 0120. Preserve the existing lease, mailbox reservation, workspace and authority checks. Polling and review reuse the stored attempt and independently confirm the expected mailbox. Return fixed failure codes for unsupported personal Gmail and terminal OAuth errors; never expose arbitrary service messages.

## Rule for next time

Provider selection must not change the identity, workspace, or pending attempt. Reject unsupported start inputs before any provider call. Never retry a consumed status as if it were a fresh sign-in; use the existing read-only mailbox reconciliation path.

## Evidence

`tests/unit/onboarding-provider.test.ts` exercises provider routes and URL validation, personal Gmail rejection without network calls, fixed error codes, and reconciliation. `tests/db/outreach-onboarding.test.ts` covers Microsoft success, cached resumption despite a different provider preference, and denied tenant/viewer/invalid-input requests before provider calls.

Database verification runs on a newly created isolated local stack with simulated transport. Live Microsoft consent is not verified by these tests. Apply migration 0120 and deploy the API before the paired frontend; existing keys must permit account creation and status reads. No cloud database changes are part of this local implementation.

Reference: https://developer.instantly.ai/guides/oauth-connection-flow

## Verification on this branch

- 303 backend unit tests and six tooling tests passed; all 20 connection-provider tests passed again after final error-code changes.
- Lint, TypeScript, production build, and runtime dependency audit passed (zero reported vulnerabilities).
- The isolated database suite initially passed 152/156 tests. One new test fixture reused a credential across distinct workspaces; it was corrected to create an unassigned outsider. A worker test needed its disposable runner's local port guard aligned to the new stack (production source unchanged). Two existing clock-sensitive tests passed on recheck. All affected files passed on rerun: 52 onboarding/team/reply tests and 27 lead-alert tests.
- The new stack was created with migrations through 0120. Existing local stacks and the cloud database were not migrated or reset.

## Rejected initialization recovery (October 21)

### Symptom

After an account-create permission rejection, checking the mailbox changed the failed attempt into “Needs review” and imposed the full ten-minute consent wait, even though no sign-in session had been created.

### Root cause

`prepare_outreach_email_review` replaced the failed state with uncertain before preserving the fact that initiation had been conclusively rejected. Review treated the default attempt deadline as a potentially active consent window.

### Approach that worked

Migration 0121 ends that deadline during authorized review only when the saved state is failed and no remote session exists. The normal independent mailbox check still decides whether to mark connected, allow a retry after confirmed absence, or retain uncertainty when the service cannot be checked. Existing leases, role/workspace checks, reservations and retry throttles remain enforced. Unknown attempts with no recorded session still wait: absence of a session ID alone is not proof of rejection.

### Rule for next time

Preserve conclusive failure evidence when entering recovery. Never use a missing session ID to bypass uncertainty after a timeout, and never turn an unavailable verification into success or permission to replay.

### Evidence

- 33 onboarding/team database tests passed on fresh `Covora_Email_Retry_Test`, including rejected start → unavailable review → confirmed absence → one fresh Microsoft initialization, unknown attempts without sessions, and failed attempts with recorded sessions.
- 303 unit tests, six tooling tests, lint, types, build and runtime audit passed. Generated schema types were unchanged.
- Browser regression used simulated provider transport and verified retry availability, a single consent initialization, and continued blocking for unknown outcomes.
- Applied migration 0121 only to the user's isolated local mailbox-test database after database tests passed. Recovered their expired attempt through the normal authenticated review API; no direct account-status edit or production migration. Live mailbox consent remains a user step.
