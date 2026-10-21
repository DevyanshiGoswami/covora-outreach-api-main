# Real collaboration in a preview workspace

## Symptom

EPM needed a durable place to request changes even while campaign results and sender activity remain previews.

## Root cause

Preview state describes outbound activity and must not be reused as a blanket substitute for permission to perform an unrelated, explicitly enabled collaboration action. Treating comments as a messaging-channel operation would either block useful discussion or weaken preview sending restrictions.

## Approach that worked

Use separate EPM-only, default-off SQL configuration and guarded comment RPCs. Reuse the existing workspace/authority lock order; derive authors from the authenticated user and protect retries with immutable command identities. Keep request and reply DTOs neutral, independent of sender/provider types. A 32 KiB endpoint-specific reader supports the 5,000-character multilingual text limit while retaining other APIs' 8 KiB default.

## Rule for next time

Scope permissions to the action being enabled. Do not turn a new collaboration capability into campaign activation, provider access, notification permission or a preview bypass. Verify direct database roles and concurrent requests in addition to UI controls.

## Evidence

`tests/unit/outbound-comments-api.test.ts`, `tests/db/outreach-comments.test.ts`, migration 0121 and `docs/epm-comments.md`. Production enablement remains a separate verified rollout step.
