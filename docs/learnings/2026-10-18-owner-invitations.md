# Owner invitations

## Symptom
Workspace invitations do not support global agency ownership. A newly activated Auth invitation appeared to have a password before the recipient chose one. Legacy database tests also targeted a fixed Docker container even when using another local gateway.

## Root cause
Client and agency roles are distinct. Auth can initialize a random password value for an invitation. Several test SQL paths hardcoded the original stack name.

## Approach that worked
Separate agency invitation RPCs with explicit active-owner checks, email binding, hashed secrets, version checks, audit records, and serialized last-owner protection. Track a confirmed user's actual password change through a private timestamp-only trigger. Derive Docker test identities from local config while retaining the pinned local API gateway and Docker label checks.

## Rule for next time
Do not infer completed password setup from a nonempty password hash, or global privileges from a client role. Never generate recovery/magic links for an existing account as part of an administrator invitation. The only approved exception (October 22, 2026) is a login that never finished joining anything, re-added by the same workspace with no other workspace or owner invitation pending; see docs/account-onboarding.md.

## Evidence
Owner database tests cover role denial, token binding, acceptance replay, expiry, reissue, revocation, last-owner protection, real local Auth activation, password setup, and preservation of existing passwords. Production rollout remains separate from local implementation.
