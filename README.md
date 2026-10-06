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

No schedules are installed initially. `OUTREACH_REPLIES_ENABLED`, `OUTREACH_SYNC_ENABLED` and `ENABLE_OUTREACH_LEAD_ALERT_EMAILS` default false, in addition to tenant/sender gates. Existing-account verification is read-only at providers. A connection badge never certifies sending readiness. Live messages, campaign launches, alerts and later synchronization activation require their own deliberate rollout.

The provider adapters preserve exact sender/conversation identity, latest-history checks and durable single-use dispatch. Unknown send outcomes are not automatically retried.
