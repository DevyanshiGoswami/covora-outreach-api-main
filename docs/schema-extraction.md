# Independent outbound schema

This database is a new product boundary. It does not connect to, inherit identities from, or migrate rows out of the content portal. Only outbound SQL contracts and their tested guards were extracted; the source migration hashes and adaptations are recorded in `schema-source-manifest.json`.

## Foundation and retained contracts

`0001_outbound_foundation.sql` creates service-owned clients (`id`, `slug`, `name`), the `outreach_app` feature gate, and Auth-linked display names. The minimal `profiles` table has only `id` and `full_name`; it contains no administrator/client roles or client binding. Display names never establish authorization. New Auth identities and active explicit `outreach_memberships` / `outreach_agency_memberships` are required.

Adapted migrations 0090–0096 retain the existing `client_outreach_*` neutral projections, message read marking, setup/team/account APIs, versioned invitation acceptance, sender configuration, conversation ownership, command deduplication, dispatch fencing, uncertain-outcome handling, retention ordering and disabled lead-alert infrastructure. Base tables remain inaccessible to browser roles; every table enables RLS and privileged functions have explicit role grants. Private definer projections return fixed safe columns.

The content-portal campaign-reference column/FK was removed from 0090. Its initial `can_read` helper returns false until 0092 installs the explicit membership implementation; it never depends on a legacy profile role. No brand campaigns, original inboxes, posts, social publish pipeline, legacy DM logs or client notification system are installed.

0091 uses the service-owned `outreach_linkedin_activity` table behind the unchanged `client_outreach_linkedin_daily` view shape. It starts empty. Rows can only represent independently ingested, known activity cohorts; unavailable outcomes remain NULL, and `outreach_log` rows cannot manufacture outcome counts. No old log rows or cross-product history are copied.

0094 drops legacy inbox/campaign reservation triggers. 0097 replaces them with product-local reservation guards: email account registration and reply-sender configuration share an advisory namespace, reject another tenant's identity in either insertion order, and allow the same identity only within its own tenant. The registered-account global unique email and reply-sender global channel/ID uniqueness remain authoritative.

0098 retains only the `worker_heartbeats` table and service-only `record_worker_heartbeat` RPC needed by the bounded worker wrapper. It creates no cron schedule, generic content operations tables, health digest or notification.

0099 adds immutable email/LinkedIn campaign ownership. Existing neutral email views keep their contracts and exclude LinkedIn assignments. LinkedIn mirroring requires the approved local campaign and current workspace/sender versions; assignment withdrawal revokes reads and replies, resets pagination, and fences stale imports. Personal conversations cannot be imported through the service RPC.

## Isolated local verification

Local project: `Covora_Outreach_API`. API 60321, database 60322, Studio 60323, local SMTP 60324, shadow database 60320. These ports were checked before creating the new stack. No pre-existing project was stopped, reset or reused. Storage, realtime, edge functions and analytics are disabled because they are unnecessary for this backend. Seed execution is disabled; migrations contain no client or user seeds.

Global public signup is disabled. The email/password login channel remains enabled so deliberately admin-created confirmed identities can sign in. Local SMTP captures any Auth test email; database fixtures create confirmed synthetic identities directly and do not send email.

`tests/helpers/env.ts` permits only the exact local gateway `http://127.0.0.1:60321`. It reads ignored `.env.test.local` keys generated from this stack's status, overwrites any inherited standard Supabase configuration only after that local-target check, and never prints credential values. SQL concurrency checks identify only the new project's Docker label. Tests seed synthetic identities/tenants and use real signed-in anon-key sessions for authorization assertions; service credentials only create/clean fixtures and exercise privileged worker procedures.

The foundation verification recorded 73 passing DB tests. The 0099 activation verification adds seven campaign scope tests; all 80 DB tests, 199 unit tests and six tooling tests pass. Fresh migration replay through the isolated shadow database reports no schema changes; `linkedin-scope-verification.json` records the exact migration hash and final catalog.

 Retained suites cover invitation role/version/identity/expiry races, account verification fences, conversation dispatch/lease/retention races, alert eligibility/deduplication/expiry/uncertain outcomes, and one real worker/database flow through fake notification transport. Independent tests additionally verify no legacy tables or open base-table grants, no inferred role access, neutral provider-free projections, tenant-private daily activity, both insertion orders and concurrent same-product email reservations, signup disabled with deliberately provisioned password login, disabled binding defaults, and service-only worker heartbeats. Typecheck and lint pass. `schema-verification.json` records the exact migration hashes and credential-free catalog evidence: all 30 public base tables have RLS, no browser base-table grants, no anonymous public definer execution, no PUBLIC execution on custom functions, and no pg_cron installation. Fixtures leave no tenant or Auth identities behind.

Run `node scripts/write-test-env.mjs` after starting this stack to generate the ignored local test configuration atomically with mode 0600. It privately captures CLI status and verifies the exact project, API port and database port; keys never enter terminal output. Run `node scripts/gen-types.mjs` to generate `src/lib/database.types.ts` against the same isolated schema, never by copying the content portal's generated types. It removes CLI status metadata before saving generated TypeScript, validates the output and atomically preserves prior types on failure. Both scripts reject target overrides. A frontend may then run its normal schema export against this isolated generated source.

## New-project deployment boundary

Only these migration files belong in the new Supabase project. Root must verify the new project's identity before applying them, never link this checkout to the old project, and provision only Covora plus explicitly authorized new Rami access. Provider credentials remain server-only in the new backend deployment. The authorized Covora activation uses only its reviewed campaign/workspace/sender bindings. Global sync and manual-reply flags remain opt-in, with the protected hosting cron installed by this release. Lead-alert policies and notifications remain disabled. No other tenant or legacy portal is an activation target.

Local DB tests prove the isolated schema and simulated command transitions. They do not prove a production provider credential, real campaign ownership, new cloud project configuration or frontend cutover; those require separate verification against the new resources only.
