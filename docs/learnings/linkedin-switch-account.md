# Switching LinkedIn accounts after an unfinished sign-in

## Symptom
A failed or abandoned sign-in could reserve an email indefinitely. Reviewing it did not offer a way to sign in with another account. Historical failures could also re-lock the email after a later confirmed disconnect.

## Root cause
The reservation intentionally survives an ambiguous remote result, but removal only accepted connected accounts. Review could recover verification; it could not cancel an unfinished sender. The email-correction guard considered failures from before a completed disconnect.

## Approach that worked
Add an explicit cancel operation bound to the latest connection ID and current person permissions. Reuse the exact-sender removal checks, campaign restrictions, reply fencing, leases, and absence confirmation. Save the previous state so a rejected cancellation restores a failed/pending attempt instead of falsely marking it connected. Restore person authority when returning to verification. Unknown DELETE outcomes only permit status reads. Definite failures with no remote operation can end locally; unknown requests without an account ID still require reconciliation. A completed disconnect bounds obsolete history when correcting a later rejected login.

## Rule for next time
Every durable reservation needs a visible way to finish, recover, or explicitly cancel it. A local failure does not prove the remote sender is absent. Do not silently delete a sender when its email is edited.

## Evidence
Seven added database/API regressions cover self-service and denied roles, different-email restart, stale dialogs, concurrent polling, rejected cancellation, uncertain DELETE, and historical failures after disconnect. Existing removal identity/campaign tests remain in force. Schema types were generated from the isolated database. Browser checks use simulated provider transport; no real login, PIN, account removal, or outreach is sent by automated tests.
