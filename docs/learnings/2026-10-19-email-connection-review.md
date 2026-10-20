# Let people verify stalled email connections

## Symptom
An uncertain connection showed Needs review with no action available to its owner, requiring a privileged manual repair even when the mailbox was already connected.

## Root cause
OAuth completion and independent mailbox verification shared a single attempt flow. The original poll cannot safely replay a consumed OAuth result, and its lease expires with the sign-in session.

## Approach that worked
Add a read-only review operation with separate prepare/read/finish RPCs. Preparation rechecks current person authorization, locks the existing client/attempt, and captures current membership and binding versions. An active request or live pending sign-in cannot be overwritten. Review uses a 45-second lease and ten-second cooldown, and reads only the current workspace and exact reserved mailbox. Completion rechecks authority, binding and lease before writing. A connected outcome requires exact mailbox/workspace identity and active, completed setup. Only a confirmed missing mailbox after the old consent deadline becomes expired and allows fresh consent; errors and unfinished sign-ins remain uncertain. No OAuth/session calls, account creation, sending grants or reservation deletion occur during review.

The frontend exposes Check connection again for recoverable email states, with fixed guidance for connected, missing, waiting, in-progress and unavailable outcomes. Both frontend and backend independently authorize; linked teammates remain self-service, while authorized managers can check external senders. No provider identifiers or keys enter client responses.

## Rule for next time
Every recoverable state needs a safe user action. Independently verify saved identities rather than replaying ambiguous external mutations. Never turn a transport failure into proof of absence.

## Evidence
294 provider/application unit tests and six tooling tests passed. The new isolated database suite passed 146/147 on a separate port; its only failure was a test-only worker port guard expecting the standard port. After adjusting that guard only in the isolated test copy, all 27 worker tests passed. Required CI runs the unmodified complete suite on the standard isolated port. New database tests cover self/tenant and private RPC denial, concurrent claims, stale bindings, revoked access, post-expiry recovery, missing-vs-unavailable evidence and persisted status. Lint/types/build and runtime audit passed. The frontend was browser-tested with real local authentication and simulated provider results; no real consent or message sending was performed.
