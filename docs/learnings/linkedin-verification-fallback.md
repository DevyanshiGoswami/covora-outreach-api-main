# LinkedIn verification fallback

## Symptom

A person received a LinkedIn email code while the portal still displayed Connecting, with no code entry. Approval in the LinkedIn app could also complete the same attempt.

## Root cause

Only two status strings enabled SubmitPin. The status endpoint documents a ten-second cache and a free-text status, so an explicit user-received code could be blocked by a delayed or ambiguous status read.

## Approach that worked

Keep explicit PIN status detection for automatic prompts, but permit the existing authenticated PIN action when the person says they received a code. Read and validate the same reserved account first. Connected, disconnected, failed or mismatched accounts never receive the code. SubmitPin remains authoritative: a 409 means this sign-in is not accepting a PIN. Never automatically retry a code or initiate another login.

Tenant/actor authorization, leases, disabled sending bindings and secret exclusion remain in place. No schema migration is required. The local consent runner was also brought up to the production safeguard against automatic failed-sender deletion.

The release audit also required Next.js 16.4.2 and a patched image dependency after advisories GHSA-2464-fhr4-w9xw and GHSA-p3m5-59mp-jv5r became visible in the dependency audit on October 22.

## Rule for next time

Treat human confirmation and cached status as separate inputs. A status label may guide the screen but should not block the provider's guarded verification endpoint when a user explicitly submits a code.

## Evidence

Unit coverage includes delayed Connecting/Challenged states, terminal/mismatched accounts and 409 without replay. Database coverage verifies an explicitly received code during cached Connecting, active-lease exclusion, no secrets in storage and disabled sending. Browser coverage exercises both code entry and app approval. The account's real provider status was read without modifying it and reported Connected; no real PIN was collected or submitted during automated tests.

References: [status API](https://docs.heyreach.io/hey-reach-api/linked-in-accounts/get-account-status), [PIN API](https://docs.heyreach.io/hey-reach-api/linked-in-accounts/submit-pin).
