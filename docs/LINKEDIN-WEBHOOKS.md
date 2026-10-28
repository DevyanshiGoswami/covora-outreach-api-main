# LinkedIn request synchronization

The dedicated outbound API receives webhook wake-ups and verifies statuses with server-side reads. It never trusts a notification to establish delivery or acceptance. The public portal reads Covora history every 60 seconds while visible and when focused; it does not poll the external service from a browser.

## Scope and behavior

Enable one explicitly onboarded workspace at a time in outreach_linkedin_hooks. The workspace must also have synchronization enabled and a live, enabled outreach_app feature. Preview clients are excluded. Discovery imports only campaigns whose entire sending-account roster belongs to the configured workspace; existing campaign assignments cannot be reassigned. Every page rechecks campaign, workspace and sender identity. Database commits recheck configuration versions.

Register CONNECTION_REQUEST_SENT, CONNECTION_REQUEST_ACCEPTED and EVERY_MESSAGE_REPLY_RECEIVED against /api/webhooks/linkedin/{workspace UUID}. A 32-byte hex secret in x-covora-webhook-secret is supported when the sender can supply one; store only its SHA-256 hash. Live verification on October 28 showed CreateWebhook and UpdateWebhook ignore customHeaders, despite documenting headers on read responses. Never claim these notifications are authenticated.

For this provider, explicitly enable unsigned_hints_enabled for the onboarded workspace. Such notifications are untrusted hints: SQL permits at most one queue wake-up per minute across all payloads, including forged or replayed ones. Suppressed notifications do not extend the cooldown. Neither headers nor payload fields can establish status; authoritative API reads and tenant/version checks remain mandatory. Payload contents are not stored, logged or used to select a recipient, sender or campaign. The known workspace endpoint is not a secret. This approach avoids putting credentials into URLs or access logs. Its tradeoff is that anyone who knows the endpoint can bring the next bounded read forward. Disable unsigned_hints_enabled to require the header instead.

The existing minute cron shares a durable lease across workers. Each tick can discover a campaign page and reconcile one request page (100 leads), with a bounded nine-second budget. Completed scans are eligible again after 15 minutes. Notifications bring assigned campaign scans forward. New campaigns are discovered within the regular discovery interval. Large campaigns take multiple ticks. Actual freshness also depends on the service detecting the LinkedIn event.

States are monotonic: sent, connected, replied. A reply requires explicit request evidence, so pre-existing connections and message-only campaigns are not fabricated as invitations. Matching native commands retain their exact saved note. Imported historical requests say when first tracked and explicitly mark the original note unavailable; the API does not return that note. No sending gate is enabled by this release.

## Operations

Monitor linkedin.webhook.received, linkedin.webhook.failed, linkedin.discovery.failed, linkedin.campaigns.discovered and linkedin.requests.sync. Logs contain outcomes/counts, not correspondence or credentials. Worker heartbeats include linkedin_request_pages and linkedin_requests_observed. Inspect scan completed_at, due_at and failures when diagnosing stale history. Invalid supplied secrets and unsigned hints without explicit opt-in return 401; storage errors return 503. Duplicate payloads coalesce, while periodic reconciliation covers missed events. Rate-limit responses back off; failed pages never advance their cursor.

Rollback: disable the affected outreach_linkedin_hooks row and deactivate its three remote webhooks. Keep history. The additive schema can remain when reverting the application deployment. Do not disable shared synchronization or change other clients to roll back this feature.

## Verification

Backend: full unit/tooling suite, full isolated database suite, lint, generated types, runtime audit and production build. Tests cover authorization, preview denial, duplicate events, scope/version fences, pagination, monotonic state and discovery. No live outreach is sent. Production verification checks opted-in hint delivery, denied invalid credentials and non-opted-in delivery, scheduled discovery and authoritative request reads. An actual new acceptance still requires a recipient to accept; a synthetic notification only wakes read-only reconciliation.

The disposable verification database uses ports 60421/60422. Its verification copy adjusts the existing local-only test guard from 60321; the running user development stack is untouched. Browser testing is intentionally omitted at the user's request.
