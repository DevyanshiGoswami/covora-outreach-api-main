# Direct account controls and confirmed removal

## Symptom

People had to open a combined Manage accounts dialog before choosing a channel. Connected accounts had no removal control, so changing a sending mailbox required manual cleanup.

## Root cause

The onboarding contract modeled sign-in attempts but no removal lifecycle. A person’s portal email also supplied every email consent attempt. Existing sign-in authority intentionally prevented administrators from authenticating linked teammates.

## Approach that worked

- Migration `0125_account_disconnection.sql` adds `disconnecting`, `disconnect_uncertain`, and `disconnected`, guarded prepare/read/finish RPCs, immutable history, removal audit events, and removal permissions in the people DTO.
- Members may remove their own accounts. Active client administrators and agency owners may remove client accounts. Operators, viewers, unrelated tenants, inactive memberships, and preview workspaces are denied. Self-authentication requirements remain unchanged.
- Requests identify a saved connection. The server resolves its identity, key, and workspace, and rechecks authority and binding versions around provider I/O.
- Active removal holds both the login reservation and the unique remote identity. Pending/unknown replies block removal. Sender replies are disabled before the external request; enabling them remains blocked until a later connection is confirmed. Removal never silently enables sending.
- Email removal verifies the workspace, exact mailbox, managed-account flag, and campaign mappings. Any campaign assignment blocks removal. LinkedIn verifies the saved account/email and active campaign count, then uses `force=false`.
- After DELETE, an independent authenticated account read must return 404 before releasing the reservation. A timeout, lost completion, or failed verification remains uncertain. Subsequent checks are read-only and never replay DELETE.
- A confirmed removal retains the person, portal membership, prior connection records, and local conversations. A new email consent attempt may use another explicitly entered sending mailbox. Failed or unfinished attempts cannot silently swap reserved mailboxes.
- Frontend changes use direct channel buttons and a focused connection/removal dialog. Existing provider authentication remains intact.

## Rule for next time

Treat disconnect as a durable external operation, with separate permission from signing in as someone. A successful response or closed browser window is insufficient evidence to release an account identity. Keep account identity exclusive throughout removal.

## Evidence

- 328 backend unit tests and 6 tooling tests passed; 183 frontend tests passed.
- The full isolated DB run initially passed 171/172 tests. It exposed a missing existing `client_removed` audit enum value; this was restored. The seven affected permission/disconnection tests then passed. The final expanded six-case disconnection suite covers preview denial, sender re-enable denial, and remote-identity exclusivity as well.
- Lint, types, frontend source boundary, both production builds, and dependency audits passed (zero runtime vulnerabilities).
- Browser tests used simulated providers against an isolated `Covora_Disconnect_Test` database: email Cancel, disconnect, refresh, different-mailbox Microsoft consent/reconnect; LinkedIn disconnect/reconnect; administrator/owner/member/viewer permissions; mobile rendering. Screenshots inspected at desktop and 390px mobile widths. No browser runtime errors.
- Applied only to the existing local consent-testing stack (`Covora_Email_Real_Test`), and verified the local People page read-only. No real account was removed; no production migration or deployment was performed.

## Provider references and limitations

- [Instantly account deletion](https://developer.instantly.ai/api-reference/account/delete-account): requires account deletion scope. Campaign-mapping and account/workspace read permissions are also needed for the checks.
- [HeyReach account removal](https://docs.heyreach.io/hey-reach-api/linked-in-accounts/remove-account): use `force=false`; account API access is required.
- Provider campaign assignments can change outside Covora between checks. LinkedIn additionally enforces the non-force removal request. Email removal has no documented equivalent atomic campaign guard; external administrators should avoid changing assignments during a removal.
- An unresolved removal remains reserved for operator/provider investigation; this change does not introduce automatic replay or automatic campaign edits.

## Release order

Apply backend migration 0125, deploy the backend, then deploy the frontend. These changes are on `feat/email-connection-flow`. Existing local provider keys stay encrypted and unchanged. Run provider removal only for a specifically confirmed account in the UI.
