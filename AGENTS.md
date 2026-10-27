# Covora Outreach API

This is the independent outbound platform backend authorized by Rami on October 5, 2026. The legacy content portal is a read-only source for tested code, never a deployment or data-write target.

- Keep `app.covora.app`, its Vercel project, database, authentication, DNS, credentials and jobs unchanged.
- Use only this product's new database/Auth project and hosting deployment. The initial pilot contains Covora and deliberately provisioned Rami access. Rami subsequently authorized a separate Chris/Ice Shaker preview workspace and a copy of his reviewed local lead roster; this does not authorize changing the content portal or importing other clients. Root handles the specifically authorized Chris-only Auth provisioning. Do not broaden credential or data copying.
- Preserve tenant authorization, explicit agency roles, RLS, function grants, reply dispatch fencing, single-attempt uncertain outcomes and existing neutral frontend contracts.
- Provider keys and identifiers stay server-only. No secrets in source, logs, test fixtures or client output.
- Rami authorized automatic inbox synchronization and human-triggered replies for Covora on October 5, 2026. On October 12 he also authorized the live DioWave outbound portal with real data from its existing Instantly campaigns. DioWave may share the email provider workspace using its own reviewed campaign assignments and exclusive sender identities. Initially enable synchronization only; keep DioWave replies disabled. Other clients require their own explicit onboarding scope. Lead-alert notifications remain disabled. Tests use simulated provider transport; do not send real prospect messages or launch campaigns without a specific message/recipient instruction.
- Extract only required outbound modules/schema. Do not copy the entire content portal or its cron configuration.
- Read installed Next documentation before changing routes or server behavior. Generate database types from the isolated schema; never hand-edit them.
- Database tests run on a new isolated local stack. Never reset or modify an existing stack.
- Run unit, tenant/role database tests, lint, types, runtime dependency audit and production build. Verify positive and denied API flows with the new login before cutting over the outbound frontend.
- User authorized building and deploying the independent outbound platform. Required paid resources, if any, need a concrete cost check; no billing-plan upgrade or unrelated project mutation.
- Keep commits area-prefixed and document nontrivial extraction decisions and verification limitations.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## ClickUp authorization (October 26, 2026)

The user authorized client-owned ClickUp OAuth from Leads, limited to authorization
and authorized Workspace metadata for now. Client administrators and agency owners
may connect/disconnect; other active roles can read metadata. No task/lead imports,
exports to ClickUp, or sync jobs are authorized by this feature. Tokens remain in
Vault. Keep state/browser proof, actor/version binding, expiry, one-time use and
post-exchange permission checks. Real provider consent requires app registration.

## ClickUp admin app setup authorization (October 26, 2026)

The user authorized a ClickUp card alongside the existing admin integrations.
Agency owners may enter the shared OAuth app Client ID and Client Secret through
verified server actions. Secrets are transient form inputs only in the frontend;
the backend stores them in Vault and returns metadata only. This configures the
Covora app; it does not connect a shared ClickUp account for all clients. Preserve
separate client grants, app-version fencing, and the authorization-only scope.
