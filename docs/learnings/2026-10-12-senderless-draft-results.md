# Senderless draft campaign results

## Symptom

An explicitly assigned draft campaign has an empty sending-account list but real lead and analytics records. The worker rejects its empty sender list before it can update any campaign results.

## Root cause

Campaign result authorization and message authorization share the same sender-list gate. An empty list cannot establish a sender for historical messages, but it does not invalidate an independently approved campaign assignment in the verified provider workspace.

## Approach that worked

Accept an explicit empty account list only for provider status `0` (draft), with the same exact campaign/workspace checks and no unresolved account tags. Continue to fetch that campaign's metadata, analytics and leads. Preserve reported historical totals, including replies or opportunities. An empty sender scope skips both message polling and queued thread reads, consumes no email-request permit, and does not advance reply cursors or watermarks.

## Rule for next time

A draft's reported reply count does not prove that its message history is available. Leave that history unavailable until an approved sender is assigned. Never infer a historical sender from an email's participants. Validate current campaign configuration separately from historical message ownership: current senders must all be tenant-approved, and every imported message must match the exact assigned campaign and a tenant-approved sender binding. Verify the credential's provider workspace and require a matching message organization ID whenever the provider supplies one. Once a sender is configured, normal scoped history synchronization can resume from its unchanged checkpoint.

## Historical sender drift

The live P5 and Reactivation Wave 1 campaign pages each contained one message from a reviewed DioWave inbox that had been removed from the campaign's current sending-account list. Both messages retained the exact assigned campaign and workspace, and their sender identities remained among the five exclusive DioWave bindings. Rejecting those messages against only the current sender list blocked each entire page and all later result refreshes.

History validation now accepts any explicitly bound sender in that tenant's verified email workspace while continuing to require the exact campaign and a matching message organization ID whenever supplied. Current campaign configuration still passes the stricter sender-list and unresolved-tag checks before any history request. The decision to poll or fetch queued history uses the **current campaign sender count**, so other approved tenant inboxes cannot accidentally enable history reads for a senderless draft. This changes no provider configuration or reply permission.

## Evidence

`tests/unit/outreach-email-worker.test.ts` verifies that a senderless draft imports real result fields and lead records, retains nonzero reported reply/opportunity totals, and makes no message or queue request whether or not other tenant inboxes are bound. Polling and queued-context tests accept exact-campaign history from an approved former sender. Missing sender lists, unresolved tags, other campaign/workspace identities, unbound senders, and non-draft empty lists remain denied before any message write or reply checkpoint.

This change does not launch a campaign, assign a sender, enable replies, send messages, or modify the content portal.
