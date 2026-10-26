# Covora-only local development access

## Intended behavior

Developers sign in with their own existing, active Covora agency-owner account.
The normal local portal displays Covora as its only client, with the existing
Covora inbox, leads, people, account setup, team and results features. It uses
live Covora data. Existing reply and integration gates still apply.

Other clients are excluded at the hosted API boundary, including direct requests
with another client ID or a person, connection, setup request or invitation from
another client. Local development cannot create/delete clients, administer agency
owners, rotate shared integration keys, rebind integrations or accept invitations
that could grant additional scope. Covora's already configured integrations can
be used to connect accounts without copying keys to developer machines.

## Flow

1. Local frontend authenticates against the independent product's central Auth.
2. `POST /api/development/session` verifies that bearer with central Auth, checks
   the active agency-owner membership and the configured client ID with slug
   `covora`, then creates a random opaque token.
3. The database stores the token's SHA-256 hash. Its original short-lived bearer
   is encrypted in Vault, alongside the owner membership version and client ID.
   No refresh token is accepted or stored. Expiry is at most one hour and no later
   than the original Auth token. Each owner can have at most ten active sessions.
4. Only the opaque token is retained locally in an HttpOnly, SameSite=Strict
   cookie. Every gateway request rechecks owner status/version, ban/deletion,
   expiry and configured client scope. Logout deletes the session and Vault secret.
   Expired records and their secrets are removed on the next session issuance.
5. Existing API routes resolve this token, enforce an explicit route/method and
   client/resource allowlist, then execute the existing verified user/RLS flow.
   New endpoints deny development tokens until added to that allowlist. Global
   onboarding context is projected to Covora; integration catalogs are omitted.
6. `/api/development/data` supports only the eight neutral views used by the
   frontend, explicit flat column selections, bounded read queries, and the
   existing mark-read RPC after checking every message's client. Client scope is
   forced independently of the caller. Embedded relations, alternate schemas,
   arbitrary RPCs, global tables and other writes are denied.

This scopes the delegated development session. It does not remove the account's
existing agency-owner authority when signing in normally to the hosted product.
Do not share an owner's password; each developer uses their own account.

## Activation (not performed by this change)

1. Review and apply migration `0136_developer_access.sql` to the independent
   Outreach database only. No legacy content-portal changes are required.
2. On the hosted backend set `OUTREACH_DEVELOPMENT_CLIENT_ID` to the reviewed
   Covora client UUID. Both that UUID and its `covora` slug must match. Then set
   `OUTREACH_DEVELOPMENT_GATEWAY_ENABLED=true` and deploy this backend.
3. Use the frontend's `docs/development-access.md` to configure its public Auth
   URL/key and the reviewed HTTPS backend origin. No private keys go locally.
4. Verify an actual owner login, only Covora in the directory, denied access to a
   second client and owner revocation before enabling developer use. No real
   email should be sent as part of verification without a specified recipient
   and approved message.

Rollback: set `OUTREACH_DEVELOPMENT_GATEWAY_ENABLED=false`. This immediately
blocks delegated requests and new sessions. Normal hosted owner sessions retain
existing behavior. Keep the migration until outstanding tokens have expired;
removing the code does not require a destructive schema rollback.

## Development model

Connected mode runs the local frontend against reviewed hosted business logic.
It does not execute unreviewed local backend code with central service credentials.
Develop backend logic with the existing isolated local stack and simulated
integrations, then deploy reviewed changes to the gateway. This distinction is
necessary to keep central keys and other clients' data off developer machines.

## Verification

The new database integration test uses two synthetic clients and a central owner
who ordinarily sees both. It checks the exchange, normal owner behavior, scoped
directory/context, blocked foreign client/person/setup IDs, shared administration,
SQL function/table permissions, logout, suspension and membership-version changes.
Unit tests cover query injection and default denial of new routes. Full existing
API and tenant/role suites must pass. All test identities and data use a new
isolated local stack; no production migration, login provisioning or real sending
is part of these tests.

### Date-range regression (October 26, 2026)

- Symptom: an owner could sign in and see the Covora directory, but opening the
  overview failed with a neutral results error.
- Root cause: the gateway rejected duplicate query keys, including the SDK's
  legitimate `day=gte...&day=lte...` date window.
- Fix: preserve repeated flat filters, each independently validated. Query
  controls and `client_id` must still be unique; the gateway always injects the
  fixed Covora client scope. No logical expressions or embedded reads are added.
- Rule: test the portal SDK's complete overview query, including date windows,
  as well as successful login and directory loading.
- Evidence: SDK regression and real database gateway tests cover both date
  bounds; duplicate scope/control and query-injection cases remain denied.
