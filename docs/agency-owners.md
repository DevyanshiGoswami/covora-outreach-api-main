# Agency owner invitations

## Scope

Implemented in the `Covora-Portal` frontend/backend checkouts on `feat/agency-owner-invitations`. These remain two repositories inside the new folder. No production migration, deployment, real invitation, or paid resource was created by this change.

Agency owner is the global Outreach role: access to all enabled client workspaces, owner invitations, and owner access management. It is distinct from client administrator and does not grant GitHub, hosting, database-console, or content-portal access.

## User flow

1. An active agency owner opens **Agency workspace → Agency owners**.
2. Enter the exact email address the recipient will use. Choose **Create owner invitation**.
3. Copy the private link and share it directly. The application does not send an email.
4. A new user opens the link, activates the account, chooses a password of 12–128 characters, and explicitly accepts agency owner access.
5. An existing user signs in using the invited email and their current password, then accepts. The inviter never receives a login or password-reset link for an existing account.
6. Review owners and invitations on the same page. Revoke pending invitations or remove owner access when needed. At least one active owner must remain.

The email is bound by the invitation and cannot be replaced with a different address during acceptance. Owner invitations last seven days; the authentication activation token has its own, potentially shorter, configured lifetime. Reissuing replaces the old owner invitation. Link secrets are only displayed at creation, carried in the URL fragment, stripped on arrival, and stored temporarily in project-scoped tab storage.

## Backend enforcement

Migration `0112_outreach_owner_invitations.sql` adds hashed owner invitations, owner audit events, and private password-readiness tracking. The password tracker records only a timestamp after a confirmed account changes its password, not a password/hash. This avoids treating Auth's initial random invite password as the recipient's chosen password.

All management and acceptance routes require a verified bearer. SQL independently checks explicit active agency membership, target email confirmation, expiry, inviter membership version, and target membership version. Acceptance is serialized and idempotent. Accepted links cannot restore revoked ownership. Removal invalidates pending invitations from that owner. Separate client memberships are preserved.

Routes: `GET/DELETE /api/outbound/owners`, `POST/DELETE /api/outbound/owners/invitations`, and `POST /api/outbound/owners/inspect` or `/accept`. Frontend uses server actions against the configured backend. Privileged Auth provisioning stays on the backend. No API keys enter browser code.

## Release requirements

Migration number 0112 is reserved after the pending account/integration migrations 0106–0111. Coordinate release order with those separate changes; this branch does not include them.

Review and apply the additive migration to the intended Outreach environment, deploy the matching backend, then deploy the frontend. Preserve existing auth/API target configuration. Backend requires its existing service credential for new-account activation links. Public signup stays disabled. No provider credentials are needed for this feature.

Before production rollout, test a new account and an existing account, verify wrong-email/non-owner denial, revoke an invitation, revoke an owner, and confirm last-owner protection. Use the intended environment's portal URL when copying links: a localhost link is only usable on the developer's machine.

Do not delete the migration tables to roll back application code: preserve the audit and ownership records. Existing owners are unaffected by the additive schema. If Auth provisioning is temporarily unavailable, the UI explicitly reports it rather than claiming a new user can activate.

## Verification completed

Local verification passed 116 database tests (including five owner-access integration scenarios), 277 backend unit tests, six tooling tests, and 130 frontend tests. Both applications passed lint, type checking, optimized builds, and runtime dependency audits (zero reported vulnerabilities). Chrome exercised new account activation, password setup, acceptance, logout/login, mobile layout, and client-admin denial. These results do not establish production deployment readiness without the reviewed migration and environment rollout above.

## Covora team synchronization (October 26, 2026)

Active agency owners now automatically appear in Covora's Team and Accounts under
the same identity, with an Agency owner badge. Owner invitations still require
acceptance. This automatic access is derived from ownership and disappears when
ownership is suspended or revoked. Separate client memberships are preserved;
connection history is retained. Only the linked person authenticates their accounts.
Other clients' rosters are unchanged. See `learnings/2026-10-26-covora-owner-team.md`.
