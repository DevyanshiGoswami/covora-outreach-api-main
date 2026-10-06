# Independent Outreach backend extraction

This backend is the privileged API for the separate Covora Outreach product. Its database, Auth users, provider credentials, deployment and workers belong to that product. The content portal is neither an API dependency nor a write target.

## Retained contracts and protections

The `/api/outbound` account, setup, team, invitation and conversation routes retain the neutral DTOs from the tested source. The frontend forwards its dedicated-project user bearer token from its server; it does not receive a service key or provider key. Every API operation verifies that bearer with the configured Auth project. Database RPCs retain tenant, current role, ownership, expected-version and dispatch authorization checks.

Conversation reads, read markers and ownership changes remain available independently of sending. Sending uses the original durable claim → provider preparation → database dispatch fence → one external attempt → durable outcome flow. Unknown outcomes never automatically retry. The verified LinkedIn status correction is included: authenticate the exact account/profile, require matching `Connected` status and no failure, then validate the conversation. Account activity is not used as authentication evidence.

Results synchronization retains explicit campaign assignments, resumable cursors, lease fencing, request budgets, fair rotation and neutral projections. It never discovers and imports every campaign automatically. The Instantly module exports scoped account verification, result reads and existing-thread replies only. Campaign creation/launch, mailbox mutations, OAuth setup, legacy personalized campaign helpers and the global provider-key fallback were removed.

Lead-alert counting, recipient rechecks, receipts, quarantine and single-attempt transport remain separate from prospect replies. Email rendering imports one HTML escaping helper, not the content portal's notification subsystem.

## Independent runtime boundary

`OUTREACH_SUPABASE_PROJECT_REF` must match the exact HTTPS Supabase project host in `NEXT_PUBLIC_SUPABASE_URL`. The known content-portal project is rejected even when supplied as the expected pin. Local access is allowed only outside production with `OUTREACH_SUPABASE_PROJECT_REF=local-outreach` and `http://localhost:60321` or `http://127.0.0.1:60321`. Other existing local stack ports are rejected.

All production user and service database clients pass this target guard. Explicit configuration objects and transport overrides exist for isolated tests; no route accepts these from a request. Provider keys resolve only through the private, tenant-bound credential reference. Ordinary provider errors and worker exceptions are converted to neutral messages.

Global gates default off and require the exact string `true`:

- `OUTREACH_REPLIES_ENABLED`: checked before enqueue, before provider preparation and again before a prepared send. Read projections show sending disabled when this gate is closed. Per-workspace and per-sender database gates still apply.
- `OUTREACH_SYNC_ENABLED`: required by the cron entry point and both sync workers, in addition to each workspace's synchronization gate.
- `ENABLE_OUTREACH_LEAD_ALERT_EMAILS`: separate notification gate, in addition to recipient policy and transport configuration.

Only `/api/cron/outreach-sync` and `/api/cron/outreach-lead-alerts` are extracted. They require the new project's `CRON_SECRET`; no schedule is installed by source extraction. Disabled calls perform no database or provider work. The narrow cron wrapper records neutral counters through the service-only `record_worker_heartbeat` RPC; it imports no content-portal operations checks or jobs. A heartbeat write failure is visible in the response rather than silently claiming health.

`GET /api/health` reports configuration readiness and gate states without identifiers or secrets. It explicitly labels the check as configuration-only. It does not claim a successful database connection, authenticated product flow, provider call or message delivery.

## Excluded source

No content portal UI, post publishing, scheduling, content clients, AI generation, Stripe, lead-DM tables, brand-campaign workers, global integration keys, content-portal auth/role helpers or legacy sender reservation system was copied. The new schema supplies the minimal client/profile records, Outreach memberships and neutral views. LinkedIn daily activity is a dedicated Outreach data source rather than an old portal message-log join.

Existing setup requests remain assisted setup; copying them does not implement a new OAuth connection screen. Existing conversation APIs remain company-scoped and existing-thread-only. Full CRM, general client–agency updates, private notes, supplier import UI and shared-workspace multi-tenant routing are not silently claimed as shipped by extraction.

## Verification and activation limits

Provider tests use synthetic transports. The result-read unit helper refuses unmatched network requests; it cannot fall through to real providers. Added tests exercise the forbidden old-project target, wrong host/pin, old local ports, missing/default-off gates, disabled cron without network work, reply denial before enqueue, gate recheck before sending, and read capabilities while sending is disabled.

Run `npm run test:unit`, `npm run lint`, `npx tsc --noEmit`, runtime audit and `npm run build`. Database role/tenant and dispatch tests run only on the isolated new stack. Before frontend cutover, verify a deliberately provisioned new user can access its own workspace and cannot access another tenant. No credentials, production data, users or sessions are copied from the content portal.

Source extraction and successful local tests do not activate synchronization, notifications, prospect replies, campaign enrollment or launch. Provider binding verification and any activation are separate operational steps. In particular, sender-only LinkedIn synchronization does not yet enforce a campaign business-purpose allowlist; keep synchronization disabled until the admitted campaign scope satisfies the Covora-only pilot and DioWave exclusion.
