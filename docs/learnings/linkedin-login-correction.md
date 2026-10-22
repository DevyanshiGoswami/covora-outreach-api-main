# Correcting a rejected LinkedIn login email

## Symptom
After failed browser-session attempts, correcting the LinkedIn login email returned a generic rejection that suggested waiting 30 seconds. Waiting did not resolve it.

## Root cause
The first start reserved the prefilled work email. The reservation table allows one email per person and channel. Later starts with the corrected email silently hit that unique constraint, then failed the reservation ownership check. The database log identified `prepare_outreach_connection` at that check. The earlier external rejections were separate and their exact reasons were not retained.

## Approach that worked
Migration 0123 allows an authorized person to correct their LinkedIn reservation only when every earlier attempt is failed, has no remote account/session and holds no active lease. A successful, pending, expired or uncertain history retains its reservation. Existing workspace locks and global identity uniqueness remain authoritative; conflicts roll back the correction. Email-channel reservations do not change.

The API returns fixed failure codes for cooldown, identity review and another person's reservation. The frontend maps those codes to clear instructions without displaying database or external response text. The form explains that a LinkedIn login email may differ from the person's work email. Backend diagnostics contain operation, method, HTTP status and a fixed reason only.

## Rule for next time
A reservation created before an external call needs an explicit correction path for definite rejections. Do not clear reservations after uncertain calls or infer permission problems from every HTTP 400. Test correcting a field after failure as well as retrying identical input.

## Evidence
- Fresh isolated `Covora_Linkedin_Retry_Test`, ports 58321/58322; all 166 database tests passed.
- Simulated browser test: rejected start, precise cooldown, corrected email, confirmed connection, refresh persistence, cleared secret inputs, mobile layout and denied viewer controls passed.
- Backend unit/tooling tests, both repos' lint/types, frontend tests/boundary check, runtime dependency audits and builds passed. The temporary frontend build used webpack because its symlinked dependencies sit outside the temporary Turbopack root.
- Migration applied only to the user's isolated local test stack on 65321/65322. No production changes or real external sign-in performed by the assistant. A real-user retry is needed to verify the external connection after removing this Covora blocker.
