# LinkedIn challenge recovery

## Symptom

After a successful disconnect, a new credential login was marked failed. Trying
a different login email then returned the identity reservation warning.

## Root cause

The status API reported `Challenged` with verification details in `failureReason`.
The adapter treated every nonempty reason as terminal, hiding code/app verification.
The sender already existed, so the identity reservation correctly blocked changing
emails. The review flow previously accepted only uncertain attempts.

## Approach that worked

Recognized challenge/PIN states remain pending even with a reason. Explicit failed
and disconnected states remain terminal; no account is considered connected until
its confirmed profile passes validation. Review can recover an older failed attempt
with a saved sender, but first performs a read-only check of that exact sender.
An unavailable, mismatched or genuinely failed sender remains unresolved. Restoring
the attempt retains its ID, login email, reservation and workspace binding and
opens a fresh verification window. No Connect, delete or PIN is sent by review.

## Rule for next time

Test actual combinations of status and metadata, including verification descriptions
in failure fields. Every recoverable state needs an accessible product action that
works without reentering credentials. Do not clear reservations to hide the symptom.

## Evidence

Provider tests cover challenges with reasons, PIN submission, actual failures and
identity mismatches. Database/API tests cover failed-attempt recovery, denied tenants,
preserved reservations, one login and explicit PIN completion. Browser checks cover
the changed-email warning, empty-secret recovery, original email display, refresh,
quiet polling, app approval and mobile code entry.

Contracts: https://docs.heyreach.io/hey-reach-api/linked-in-accounts/get-account-status
and https://docs.heyreach.io/hey-reach-api/linked-in-accounts/submit-pin.
