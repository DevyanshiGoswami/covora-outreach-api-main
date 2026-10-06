# Covora Outreach API

Independent backend for the outbound client platform at covora.app. It owns account setup, tenant/team access, email and LinkedIn conversation mirrors, and explicitly gated replies. The separate frontend receives only neutral, tenant-authorized data.

The existing content portal is not a runtime dependency. This service uses a dedicated Supabase database and Auth project, its own Vercel deployment and provider credentials. Runtime configuration refuses the content portal database. No legacy content, publishing, billing or generation workers are included.

## Development

Use Node 22, `npm ci`, and the project's isolated Supabase stack. Local services use ports 60321–60329 and project ID `Covora_Outreach_API`; never reset another stack. Copy `.env.example` into an ignored local file with local-only values and `OUTREACH_SUPABASE_PROJECT_REF=local-outreach`. Production secrets are never development fixtures.

Run `npm run dev` on port 3011. `/api/health` reports configuration readiness and feature gates; it does not claim provider or database connectivity. Public routes under `/api/outbound` require a verified bearer session from the independent Auth project. Database RLS and guarded RPCs authorize every tenant operation.

## Verification

`npm run test:unit`, `npm run test:db`, `npm run lint`, `npm run typecheck`, `npm audit --audit-level=high`, and `npm run build` must pass. The DB test helper refuses all targets except the isolated local gateway. Generate types from this schema with `npm run gen:types`; retain only generated TypeScript, never CLI status text.

## Deployment and activation

Only this product's new hosting/database targets may be changed. The outbound frontend switches its public database URL/key and server API origin together after the new login, API and tenant tests pass. Provision only the Covora pilot; do not bulk-copy the old Auth database or other clients.

The protected `/api/cron/outreach-sync` job runs every minute, with a bounded worker lease and resumable pagination. Global sync and reply flags still default false. The authorized Covora pilot enables `OUTREACH_SYNC_ENABLED` and `OUTREACH_REPLIES_ENABLED` only with its reviewed campaign assignments and tenant/workspace/sender bindings. `ENABLE_OUTREACH_LEAD_ALERT_EMAILS` remains false; no notification schedule is installed.

Email imports validate the exact assigned campaign, workspace and approved sender set before reading campaign messages, leads or analytics. Polling includes received and externally sent messages. LinkedIn imports require explicit campaign assignments and exclude personal and group conversations. With no LinkedIn campaign assignments, the worker makes no inbox history requests. Provider credentials stay in the backend: the email integration needs the existing read scopes plus `emails:create`, not workspace-wide administration. A connection badge alone does not certify sending readiness.

Replies are initiated by a signed-in client or Covora operator. Enabling them does not send a message or launch a campaign. Verify tenant isolation, provider read access, sync heartbeats and the portal composer before handing off; actual delivery remains unverified until an explicitly authorized real reply is sent.

The provider adapters preserve exact sender/conversation identity, latest-history checks and durable single-use dispatch. Unknown send outcomes are not automatically retried.
