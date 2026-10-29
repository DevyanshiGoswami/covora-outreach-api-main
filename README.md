# Covora Outreach API

Independent outbound API for the existing `covora-outreach` frontend. It owns account onboarding, tenant/team access, email and LinkedIn conversation mirrors, and explicitly gated replies. The frontend receives tenant-authorized data; this repository does not serve a separate portal UI.

The existing content portal is not a runtime dependency. This service uses a dedicated Supabase database and Auth project, its own Vercel deployment and provider credentials. Runtime configuration refuses the content portal database. No legacy content, publishing, billing or generation workers are included.

## Development

For the new **admin/client login → client workspace → add person → connect accounts** flow, see [Account onboarding](docs/account-onboarding.md). It includes local startup, demo login, provider configuration, and operational limitations.

Use Node 22, `npm ci`, and the project's isolated Supabase stack. Local services use ports 60321–60329 and project ID `Covora_Outreach_API`; never reset another stack. Copy `.env.example` into an ignored local file with local-only values and `OUTREACH_SUPABASE_PROJECT_REF=local-outreach`. Production secrets are never development fixtures.

Run `npm run dev` on port 3011. `/api/health` reports configuration readiness and feature gates; it does not claim provider or database connectivity. Public routes under `/api/outbound` require a verified bearer session from the independent Auth project. Database RLS and guarded RPCs authorize every tenant operation.

## Local Inbox and New outreach (development only)

Use an **empty** development database project, never production. Settings in `.env.local`:

```
OUTREACH_DEV_SEED_PROJECT_REF=<same value as OUTREACH_SUPABASE_PROJECT_REF>
OUTREACH_INSTANTLY_MODE=mock
OUTREACH_PORTAL_SEND_ENABLED=true
OUTREACH_REPLIES_ENABLED=true
OUTREACH_SYNC_ENABLED=true
OUTREACH_INSTANTLY_WEBHOOK_SECRET=<40+ random characters>
CRON_SECRET=<random string>
```

1. `npx supabase db push` (applies migrations to the linked development project).
2. `npm run dev:seed` — resets and creates the workspace "Covora · Dev". It refuses any database that contains other clients and any production environment. `npm run dev:seed -- --clear` removes the seed data.
3. `npm run dev` (backend, port 3011) and, in the `covora-outreach` frontend, `npm run dev` (port 3001) with `OUTBOUND_API_ORIGIN=http://127.0.0.1:3011` and the same public database URL and anon key.
4. Sign in at http://127.0.0.1:3001/login:

| Role | Email | Development password | Sender mailbox |
|---|---|---|---|
| Admin (agency owner) | admin@covora.test | CovoraDevAdmin#2026 | — |
| User | alice@covora.test | CovoraDevAlice#2026 | alice.sender@covora-mock.test |
| User | bob@covora.test | CovoraDevBob#2026! | bob.sender@covora-mock.test |

These accounts exist only in a seeded development database. Alice and Bob each have one conversation; the admin sees both. A third, non-portal thread stays hidden because the workspace uses the portal-only Inbox.

5. `npm run dev:verify` — signs in as each user and checks positive and denied access.

Mock sending engine (no real API, no real mail; state in `.mock-instantly.json`):

| Command | Simulates |
|---|---|
| Inbox → **New outreach** | Send: creates a one-lead campaign and its first email |
| `npm run mock -- reply priya@prospect-mock.test "text"` | Prospect reply + `reply_received` webhook |
| `npm run mock -- reply <email> --twice` | Same webhook delivered twice (no duplicate message) |
| `npm run mock -- reply <email> --no-webhook` then `npm run dev:sync` | Missed webhook recovered by the backup sync |
| `npm run mock -- outside` | Reply in a campaign created outside Covora (ignored) |
| `npm run mock -- unrelated` | Ordinary mail to the sender mailbox (ignored) |
| `npm run dev:sync -- --watch` | Local stand-in for the per-minute cron |

The webhook only queues a scoped fetch for a recorded portal campaign; the sync worker then re-reads that campaign from the provider and stores messages keyed by provider email ID, so duplicates cannot be created. The backup sync polls only campaigns recorded in this database.

**Real integration test** (`OUTREACH_INSTANTLY_MODE=live`): set `OUTREACH_DEV_INSTANTLY_WORKSPACE_ID` before seeding, and list the exact test addresses in `OUTREACH_PORTAL_ALLOWED_SENDERS` and `OUTREACH_PORTAL_ALLOWED_RECIPIENTS`. Any other sender or recipient is refused before a provider call. Do not create the provider webhook in the shared workspace without approval.

## Verification

`npm run test:unit`, `npm run test:db`, `npm run lint`, `npm run typecheck`, `npm audit --audit-level=high`, and `npm run build` must pass. The DB test helper refuses all targets except the isolated local gateway. Generate types from this schema with `npm run gen:types`; retain only generated TypeScript, never CLI status text.

## Deployment and activation

Only this product's new hosting/database targets may be changed. The outbound frontend switches its public database URL/key and server API origin together after the new login, API and tenant tests pass. Provision only the Covora pilot; do not bulk-copy the old Auth database or other clients.

The protected `/api/cron/outreach-sync` job runs every minute, with a bounded worker lease and resumable pagination. Global sync and reply flags still default false. The authorized Covora pilot enables `OUTREACH_SYNC_ENABLED` and `OUTREACH_REPLIES_ENABLED` only with its reviewed campaign assignments and tenant/workspace/sender bindings. `ENABLE_OUTREACH_LEAD_ALERT_EMAILS` remains false; no notification schedule is installed.

Email imports validate the exact assigned campaign, workspace and approved sender set before reading campaign messages, leads or analytics. Polling includes received and externally sent messages. LinkedIn imports require explicit campaign assignments and exclude personal and group conversations. With no LinkedIn campaign assignments, the worker makes no inbox history requests. Provider credentials stay in the backend: the email integration needs the existing read scopes plus `emails:create`, not workspace-wide administration. A connection badge alone does not certify sending readiness.

Replies are initiated by a signed-in client or Covora operator. Enabling them does not send a message or launch a campaign. Verify tenant isolation, provider read access, sync heartbeats and the portal composer before handing off; actual delivery remains unverified until an explicitly authorized real reply is sent.

The provider adapters preserve exact sender/conversation identity, latest-history checks and durable single-use dispatch. Unknown send outcomes are not automatically retried.
