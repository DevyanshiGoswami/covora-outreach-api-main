# Separate agency control permissions

## Symptom
Every active agency owner could add/remove clients and revoke other owners. The user requested these three actions be limited to two existing accounts.

## Root cause
The owner role combined operational access with client lifecycle and owner-removal authority.

## Approach that worked
Migration 0114 adds `outreach_agency_permissions`, keyed to the immutable agency-owner user ID. `can_manage_clients` guards both client creation and removal; `can_remove_owners` guards owner revocation. Both default to false. Only trusted database administration can write grants; there is no authenticated API for granting them. SQL locks and checks both active owner membership and the permission row before each action. The existing invitation, tenant, reply and version protections remain in place.

The permissions table is separate from membership: granting controls does not increment membership versions or invalidate pending invitations. Accepting an owner invitation creates no control grant. Active ownership remains required even if a grant exists. Context/list RPCs expose only the caller's capability booleans so the portal can hide unavailable actions.

Production grant data is applied separately after verifying the two requested identities by both ID and email. Do not seed production identities into local migrations or infer capabilities from email/name in application code. All other accounts remain denied by default. Integrations, client invitations, owner invitations and ordinary owner access retain their existing policy.

## Rule for next time
Grant sensitive actions independently of broad owner membership. Never use a hidden button as the authority boundary, and never automatically grant controls when inviting another owner.

## Evidence
New isolated database initialized through 0114. The database suite covers 140 cases; one older integration fixture needed an explicit removal grant and passed its focused rerun. New cases cover denied ordinary owners through API and direct RPC, denied permission-table access, separate grants, existing-session revocation, suspended owners, invitation acceptance and preservation of pending invitations. All 288 unit and 6 tooling tests, lint, types, build and runtime audit passed. Browser verification covers both permission levels and a stale form rejected after a grant is revoked. No production clients or owners are removed for verification.
