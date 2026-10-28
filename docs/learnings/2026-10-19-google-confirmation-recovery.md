# Confirm a mailbox after an unreadable OAuth result

## Symptom
Google reported authorization complete and the mailbox appeared in the email service, while the portal showed Needs review.

## Root cause
Production logs placed both failures at the OAuth status read, with no HTTP error status recorded. The adapter treated an unreadable or unexpected session result as permanently uncertain and never independently checked the reserved mailbox. The consumed response was not retained, so its exact payload or transport failure cannot be established retrospectively. A direct account read later confirmed the expected mailbox, matching organization, active status, and completed setup.

## Approach that worked
After an uncertain Google status read, make one read-only account lookup using the already verified workspace, fixed expected email, and the original request deadline. Confirm only an exact matching active mailbox with completed setup. Never replay OAuth initialization or the one-time status read. Explicit mismatched identities and known failed/pending/expired session results keep their existing behavior. If independent verification is unavailable or mismatched, preserve review. Record only a fixed error category in logs.

An owner-authorized, guarded production reconciliation corrected the already affected connection and mailbox record only after independent provider verification. It retained the account reservation and audit history. No sending permission or campaign state changed.

## Rule for next time
A consumed OAuth result is not a durable account-status source. Recover an unreadable result with independently scoped read-only evidence; never equate a popup completing with a verified mailbox, and never reset an uncertain attempt blindly.

## Evidence
Provider unit regressions cover unreadable completion, missing account, wrong organization/mailbox, inactive/setup-pending accounts, explicit identity mismatch with incomplete payloads, known terminal failures, no consent/session replay, and no secret leakage. Local unit/tooling, lint, types, runtime audit and build are required; isolated role/tenant/database tests run in CI before merge. No schema or frontend change. Live end-to-end consent after this release still requires a user-operated Google sign-in; the previously affected mailbox was independently reconciled.
