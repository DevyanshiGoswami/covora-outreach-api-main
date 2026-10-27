# Covora owner and team identity

## Symptom

Agency owners and Covora's People/Team lists represented the same internal team
separately. Owners needed a second client invitation to connect their own accounts.

## Root cause

People were synchronized only from explicit client memberships. Global ownership
was intentionally excluded from client sender rosters.

## Approach that worked

Migration 0137 treats active ownership as a derived team grant for the client whose
slug is `covora`. Team reads union owner identities with direct membership identities;
one user appears once. Explicit membership rows, roles, versions and states are
never overwritten. Owner revocation/suspension immediately removes the derived
grant, leaving independent memberships intact.

Verified owner identities are linked to People with the existing one-time identity
rules, on owner activation, Covora creation, email confirmation, and migration
backfill. An existing person ID, name and connection history are preserved. Different
Auth identities are never merged. A conflicting previously linked email requires
manual review rather than reassignment.

Owners connect only their own linked Covora person. Existing direct member authority
stamps stay valid; owner-only connection sessions include the owner membership
version and become invalid when that grant changes. No mailbox or connection is
created by synchronization. Retained former-person rows preserve connection history
and show inactive access when no independent grant exists.

Team and People return an owner badge. The owner section manages automatic access;
Team continues to manage ordinary client memberships. Other clients receive no
new roster entries or self-connection privileges.

## Rule for next time

Derive access from its authoritative grant instead of copying privileges into an
independent membership that could outlive revocation. Test the actual connection
authority as well as list visibility and deduplication.

## Evidence

Database tests cover owner invitations, verified identity linking, existing connected
records, repeated activation, Covora-only scope, owner removal, session fencing,
independent membership preservation and viewer fallback. UI contract tests cover
validated owner badges. Use a new isolated stack for regression and browser tests.

## Release

Apply migration 0137 to the independent Outreach database, then deploy the backend
and frontend. Existing verified active owners are reconciled by the migration; no
new Auth accounts, invitations, emails or service credentials are created. Confirm
all active owners have exactly one Covora person, no conflicting identity links,
unchanged direct memberships/connections, and unchanged other-client rosters.
