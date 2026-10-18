# Admin integrations release

Prepared against `rhahami/covora-outreach-api` main `07176dd` on 17 October 2026. Companion frontend: `rhahami/covora-outreach`, branch `feat/live-admin-integrations`.

## Included

Agency-owner API-key verification, encrypted Vault storage, connection checks/rotation/removal, and client assignment. This reuses the local onboarding implementation: its context/authority RPCs, people and account-connection flows, invitations and identity fencing are included dependencies. Real provider secrets are never committed or migrated from a developer's local database.

## Database changes

The live main already has `0105_outreach_lead_review_escrow.sql`. Preserve it. The local feature's migration numbers have been shifted to avoid that collision:

| Release migration | Purpose |
| --- | --- |
| 0106_outreach_onboarding.sql | Onboarding tables, context, client/person creation and workspace binding |
| 0107_onboarding_reservation_fencing.sql | Connection reservations and authority checks |
| 0108_admin_integrations.sql | Encrypted provider keys and owner-only integration management |
| 0109_integration_expired_attempts.sql | Expired-attempt handling |
| 0110_team_account_people.sql | Link accepted teammates to sending identities |
| 0111_connection_ownership_review.sql | Mark attempts needing authority review |

These are new production migrations. If a nonproduction database already applied the old feature numbering (0105–0110), do not replay or blindly repair its migration history. Validate against a new isolated stack or reconcile that development database separately. Never reset a database containing client work.

## Deployment order for the teammate with access

1. Verify the existing dedicated outbound Supabase project and backend Vercel project from the deployed environment. Do not target the separate content portal database or `app.covora.app`.
2. Check the target's migration history and take the usual backup/recovery checkpoint. Confirm Vault is supported. Review the six pending migrations above, including the accepted-member backfill.
3. Apply those migrations to the dedicated outbound database using its normal migration workflow. Do not alter existing provider bindings or enable new sending/sync/alert gates.
4. Deploy this backend branch to the existing backend project. Preserve the dedicated project reference, public key and service-role key. The saved connector path uses Vault; existing environment-configured provider credentials remain supported.
5. Check `/api/health`; verify an unauthenticated request to `/api/onboarding/admin-integrations` is denied. Confirm the existing intended agency owner's explicit membership. Never grant ownership based only on an email address.
6. Deploy the companion frontend to the existing `covora.app` project with the same dedicated Auth project and backend origin. Run its deployment configuration check with independently verified values.
7. Sign in as the agency owner, open **Agency workspace → Integrations**, verify and save each provider key, refresh, and check the saved metadata. Keys must not be returned. Assign the intended connections in each client's Accounts → People cards only after checking client ownership.
8. Verify a client administrator/member cannot access integration management. Confirm the existing lead priority/escrow screens and client results still work. Use consenting controlled accounts for further account-connection testing; this release does not authorize prospect messages.

The frontend hides owner controls if onboarding context is unavailable, so deploy database and backend before frontend. Saving an integration does not launch a campaign or enable sending. HeyReach key validation alone does not establish that a supplied workspace ID belongs to that key; the operator must verify the pair.

## Recovery

Before anyone uses new connections, reverting the frontend/backend deployments leaves the additive schema in place. After Vault credentials have been assigned, reverting to a backend without Vault resolution can break existing account checks, sync and replies for those assignments. In that case prefer a forward fix or an explicit, reviewed provider-binding recovery; do not silently revert, delete saved secrets or drop migration tables. Do not transfer secrets through PR comments or chat.

## Status

Prepared and tested locally; production deployment and cloud migration application require the teammate's existing Vercel/Supabase access. Local test results are recorded in the pull request and do not prove production readiness or live provider delivery.

## Local verification (17 October 2026)

- Frontend: 155 tests; backend: 286 unit tests, 6 tooling tests, and 126 database tests passed.
- Both repositories passed lint, type checking, production builds, and full dependency audits (zero reported vulnerabilities). Frontend source-boundary check passed.
- Applied the complete schema, including upstream lead escrow and migrations 0106–0111, to a fresh isolated Docker project. Existing local client data and credentials were preserved. Test-only project-name substitutions were restored after the run.
- HTTP checks against local development servers: configuration health 200, unauthenticated integration access 401, owner access 200, client administrator access 403. Production runtime correctly refused the local database target.
- Browser checks used synthetic local owner/client identities and the existing portal UI. Provider transports in automated connection tests were simulated; no real provider keys, account authentication, or messages were used for this release verification.
- Production target verification and deployment remain outstanding because the available hosting login is expired and the teammate owns deployment access.
