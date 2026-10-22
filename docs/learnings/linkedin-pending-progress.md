# LinkedIn pending progress and code submission

## Symptom

A LinkedIn attempt stayed pending with a verification-code field even though the account service reported Disconnected. There was no useful next action when no code arrived.

## Root cause

Status parsing required `profile.profileUrl` to be a string before inspecting the connection status. Disconnected accounts can return a profile object containing null fields. Parsing failed and the catch path silently returned pending. The frontend also treated every pending attempt as a code request.

A browser regression exposed a second issue: the database applied the status-read cooldown to PIN submission. A code submitted immediately after discovering a code request could be ignored without explanation.

## Approach that worked

- Parse the account identity and status first. Disconnected or explicit failure becomes failed regardless of incomplete profile fields. Confirmed connections still require a valid LinkedIn profile and the existing identity checks.
- Return an allowlisted `nextStep`: connecting, verification_code, syncing, or check_status. Generic pending and unknown status strings never establish that a code was sent.
- Read current account status before submitting a PIN. Submit only for an explicit PIN-required status. Keep transport failures unresolved and return fixed safe error codes; never expose provider response text.
- Migration 0126 keeps the active lease and authorization fences but limits the 10-second cooldown to polling. Concurrent PIN attempts receive an explicit check-in-progress response without another provider submission.
- Preserve existing actor, tenant, workspace-version, remote-identity, retry and expiry checks. Going back in the UI does not cancel or replay the external login.

## Rule for next time

Validate fields needed for each state separately. A missing success-only field must not hide a definitive failure. Human verification submissions need different throttling from background reads, while retaining the same concurrency fence.

## Evidence

- 333 unit tests, 6 tooling tests and 29 focused onboarding database tests passed. Database coverage includes tenant denial, null-profile failure, explicit code requests, immediate code submission and an active-lease conflict.
- Frontend browser regression used simulated providers on a separate local database. It covered back navigation, status checks, PIN entry, preserved code input, failure/retry, refresh persistence, mobile layout and role restrictions.
- Lint, types, runtime dependency audit and production build passed. Public schema types regenerated from the isolated database are unchanged after whitespace normalization.
- Read-only diagnostics on the user's local provider binding confirmed a Disconnected response with null profile fields. Tests did not submit real account credentials or codes, remove accounts or send messages.
- Migration 0126 was applied to the existing local consent-testing database and its backend restarted. A browser status check restored the retry screen; Back worked and no code field was shown. No new provider sign-in was started.

## References and release order

- [Account status](https://docs.heyreach.io/hey-reach-api/linked-in-accounts/get-account-status) is cached for ten seconds and documents a free-text status rather than an exhaustive enum. Unknown values remain checkable pending states.
- [Submit PIN](https://docs.heyreach.io/hey-reach-api/linked-in-accounts/submit-pin) applies only to an account awaiting a PIN.
- Apply migration 0126, then load the backend and frontend changes together. This work is local; production still needs its normal release process.
