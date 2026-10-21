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
