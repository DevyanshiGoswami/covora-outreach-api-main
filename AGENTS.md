# Covora Outreach API

This is the independent outbound platform backend authorized by Rami on October 5, 2026. The legacy content portal is a read-only source for tested code, never a deployment or data-write target.

- Keep `app.covora.app`, its Vercel project, database, authentication, DNS, credentials and jobs unchanged.
- Use only this product's new database/Auth project and hosting deployment. The initial pilot contains Covora and deliberately provisioned Rami access. Rami subsequently authorized a separate Chris/Ice Shaker preview workspace and a copy of his reviewed local lead roster; this does not authorize changing the content portal or importing other clients. Root handles the specifically authorized Chris-only Auth provisioning. Do not broaden credential or data copying.
- Preserve tenant authorization, explicit agency roles, RLS, function grants, reply dispatch fencing, single-attempt uncertain outcomes and existing neutral frontend contracts.
- Provider keys and identifiers stay server-only. No secrets in source, logs, test fixtures or client output.
- Rami authorized automatic inbox synchronization and human-triggered replies from the outbound portal on October 5, 2026. Activate only reviewed Covora campaign/account bindings after verification; DioWave and other clients stay excluded. Lead-alert notifications remain disabled. Tests use simulated provider transport; do not send real prospect messages or launch campaigns without a specific message/recipient instruction.
- Extract only required outbound modules/schema. Do not copy the entire content portal or its cron configuration.
- Read installed Next documentation before changing routes or server behavior. Generate database types from the isolated schema; never hand-edit them.
- Database tests run on a new isolated local stack. Never reset or modify an existing stack.
- Run unit, tenant/role database tests, lint, types, runtime dependency audit and production build. Verify positive and denied API flows with the new login before cutting over the outbound frontend.
- User authorized building and deploying the independent outbound platform. Required paid resources, if any, need a concrete cost check; no billing-plan upgrade or unrelated project mutation.
- Keep commits area-prefixed and document nontrivial extraction decisions and verification limitations.
