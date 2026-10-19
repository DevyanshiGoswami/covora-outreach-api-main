# Account onboarding in the existing Outreach portal

Originally implemented on `feat/account-onboarding`; prepared for release on `feat/live-admin-integrations`, and combined with agency owner invitations on `feat/agency-client-integrations` in the `Covora-Portal` organization checkouts. See [the release guide](admin-integrations-release.md) for deployment order and migration numbering. Local verification does not establish live provider access, message delivery, or campaign readiness.

## What is available

Agency navigation retains Clients, Integrations, and Agency owners together. Normal sign-in still opens the existing home/Overview portal; Agency remains a separate navigation destination. Owner invitations and client invitations are separate flows: accepting an agency invitation grants global owner access, while accepting a client invitation grants only that client role.

- Supabase email/password login for agency administrators and invited clients.
- **Clients:** agency owners create client workspaces and copy private client-administrator invitation links. The portal does not send invitation email.
- **Team:** invite client administrators, members or viewers. New users set a password; existing users sign in. Accepted client teammates automatically appear in Accounts. Pending invitations stay in Team.
- **Accounts:** client administrators and members connect their own Google Workspace email through Instantly, LinkedIn through HeyReach, or both. A separate sender-only option adds someone without a portal login for assisted setup.
- **Agency workspace → Integrations:** agency owners enter an API key to verify and save an encrypted connector, check its status, replace its key, or remove an unassigned connector. Saved keys are never returned to the browser. Client workspace connections can select these saved connectors.
- A person's setup is complete after at least one channel has a confirmed connection. This is an observation at connection time, not continuous monitoring or campaign readiness.

## Start locally

Use Node 22 (`nvm install`, then `nvm use`) and Docker Desktop. These commands target only this repository's isolated Supabase stack, ports 60321–60329:

```sh
npm ci
npx supabase start
npm run test:env
npm run setup:local
npm run dev:local
```

The API runs on **http://127.0.0.1:3011**. The UI is in the sibling `covora-outreach` repository on the matching `feat/agency-client-integrations` branch. Configure and start it in a separate terminal:

```sh
# From covora-outreach-api: writes public settings only; refuses to overwrite an existing file.
node scripts/local-portal.mjs frontend-env
cd ../covora-outreach
npm ci
npm run dev
```

Open **http://127.0.0.1:3001/login?next=/agency**. Read the synthetic administrator email/password from `.onboarding-local.json`; this private file is gitignored. The setup script creates an agency owner and a local demo workspace. It does not print credentials, reset a database, or touch cloud identities. Re-running it preserves the recorded login.

For a local stack following the upstream migration history through `0105_outreach_lead_review_escrow.sql`, apply pending migrations with `npx supabase migration up --local`. If a developer stack used the earlier onboarding numbering (0105–0110), use a fresh isolated stack or reconcile its migration history separately as described in the release guide. Do not replay renamed migrations or reset an existing stack. `npm run dev:local` explicitly pins the application to the isolated local database and disables sync, replies, and alerts. Without provider configuration, login, client invitations and adding people work; connection buttons explain that an administrator must configure a channel.

For normal deployment configuration, use `.env.example` and `npm run dev`. The database runtime guard still rejects the legacy content portal project. The portal uses the same independent Auth project and bearer-token checks as the existing APIs.

## Admin and client flow

1. An existing agency owner signs in. For a new independent production project, provision the initial Auth user and an active `outreach_agency_memberships` row through your trusted deployment administration. Public signup is disabled; there is no first-visitor ownership grant.
2. The owner opens **Agency workspace → Add client** to add Covora’s own workspace or a customer.
3. The owner opens **Agency workspace → Integrations** and saves the provider connections. In the client’s **Accounts → People**, the owner selects a saved connection directly in the **Email** or **LinkedIn** card and clicks **Assign connection** or **Change connection**. Each card keeps the saved assignment name and status visible, preselects its current connection, and displays save errors inline. Assignment metadata is owner-only and contains no credentials or remote workspace identifiers. Instantly is checked against the expected workspace ID. HeyReach's documented key check validates the key; the deployment administrator is responsible for supplying the correct workspace/key pair.
4. The owner uses **Invite client administrator**, enters the customer's email, and privately shares the generated link.
5. A new customer opens the invitation, chooses a password, and accepts workspace membership. An existing user signs in normally and accepts the invitation. The invited email must match the confirmed Auth identity.
6. The accepted client administrator appears in **Accounts → People**, marked **You** when signed in. They connect their own accounts, and invite teammates from **Team**. Members connect themselves after accepting. Viewers have reporting access only.

Agency owners see enabled client workspaces; assigned operators see their assigned clients. Accounts remains scoped to the selected client. Agency owners, client administrators and assigned operators see all people and connection statuses there. Client members/viewers see their own person. Managers cannot authenticate a linked teammate; each active administrator/member connects themselves. Managers can assist explicitly external senders. Agency access does not automatically create a sender in every client. Only the agency owner creates clients, assigns provider workspaces or invites client administrators; client administrators invite member/viewer roles.

## Provider configuration

The owner can configure API keys directly in **Agency workspace → Integrations**:

1. **Connect Instantly:** enter a connection name and API v2 key, then **Verify and save**. The backend discovers the workspace with `/workspaces/current`.
2. **Connect HeyReach:** enter a connection name, API key and the corresponding workspace ID, then **Verify and save**. The backend checks the key. The owner must supply its correct workspace ID; the key-check endpoint does not prove the ID matches.
3. Assign these saved connections directly in each client's Email and LinkedIn cards under Accounts → People. No provider environment-variable edits are needed for connections saved through the portal.

The key field is cleared immediately on submission. The frontend server action and backend both require an active agency owner. The backend verifies before saving, stores the key with Supabase Vault authenticated encryption, and returns display metadata only. The database rechecks owner membership/version on completion. A replacement must belong to the same workspace; failed validation leaves the prior key intact. Assigned connections cannot be removed, and key replacement is blocked during pending account sign-ins. Checks display the last observed result, not continuous provider health. Removal deletes the saved Vault secret; it does not revoke the provider key or delete a provider account.

The existing one-client-per-LinkedIn-workspace restriction remains. This tab implements provider configuration; it does not yet implement global automatic assignment across all clients.

Do not paste secrets into chat, commit them, or use `NEXT_PUBLIC_` names for them. Instantly supplies the Google OAuth application for this flow.

### Existing environment configuration

Deployment-managed connections remain supported for compatibility. Their keys and workspace catalog can still be configured **in the backend environment**.

`OUTREACH_ONBOARDING_WORKSPACES` is a JSON array. Example shape (replace IDs with your actual independent outbound provider workspaces):

```json
[
  {
    "id": "covora-mail",
    "label": "Covora managed email",
    "channel": "email",
    "workspaceId": "11111111-1111-4111-8111-111111111111",
    "credentialRef": "OUTREACH_INSTANTLY_COVORA"
  },
  {
    "id": "customer-linkedin",
    "label": "Customer LinkedIn workspace",
    "channel": "linkedin",
    "workspaceId": "YOUR_EXISTING_HEYREACH_WORKSPACE_ID",
    "credentialRef": "OUTREACH_HEYREACH_CUSTOMER"
  }
]
```

Set the referenced variables to the corresponding keys in the server secret store. Client assignment responses include only the catalog alias, label, channel and whether a key is configured. The owner Integrations response includes connection ID, label, channel, version, check timestamps and assignment state. They omit credential references and provider workspace/account IDs. The Google authorization URL is the necessary exception: it contains provider-issued OAuth parameters and is returned only to the authorized session initiator.

### Instantly

- Key scopes: `accounts:create`, `accounts:read`, and permission to read `/workspaces/current`.
- Google Workspace accounts only. Personal `@gmail.com` / `@googlemail.com` accounts are rejected.
- `POST /oauth/google/init` starts the session. The person opens the returned Google consent link in a new tab and signs in with the exact email recorded for that person.
- The backend polls `GET /oauth/session/status/{sessionId}`, then verifies the resulting mailbox and workspace. The portal polls every 10 seconds.
- Completed/error OAuth results are consumed on their first read. Database claims serialize polling and save the result before returning it to the browser. Refreshing the UI does not consume it again.
- Email provider workspaces may be shared where existing sender reservations permit it. An email identity remains exclusive to one client/person.

### HeyReach

- Key verification accepts HTTP 200 and 204 without requiring JSON: the authentication overview documents 200 and the endpoint reference documents 204. Rejected checks log only the channel and HTTP status; transport failures log a fixed message. Keys, workspace IDs and upstream response bodies are never logged.
- Requires HeyReach's **Account Login API** feature. An API key alone does not prove this feature is enabled.
- Each client uses a dedicated HeyReach workspace and dedicated key reference under the existing LinkedIn isolation model. Covora can manage all those workspaces operationally; the portal does not create paid provider workspaces or seats.
- `POST /li_account/Connect` receives the login email, password and usual login country. `inboxScrapeMode` is `HeyReachOnly`; no custom proxy or persistent 2FA secret is collected.
- The backend polls `GetAccountStatus`. A verification-code form is available while pending; `SubmitPin` receives the saved account ID and the entered PIN. Public documentation does not enumerate every intermediate status, so the portal does not guess which string means PIN-required.
- Passwords/PINs are used only for the current request, never persisted in the database, logs, or response. Clear/reset the form immediately on submission. Infrastructure must also avoid request-body logging on `/api/onboarding/connections`.
- A confirmed LinkedIn identity is reserved through a sender binding with **sending disabled** and no campaign assignments. Existing inbox/reply authority is not broadened.

## Reliability and security

Migrations 0106–0107 add people, private connection attempts/reservations, an append-only onboarding audit and guarded RPCs. Private tables are inaccessible to anonymous/authenticated roles. The backend uses the service role only after user-scoped authorization. Completion rechecks the initiating user's role/version, client feature, workspace version, lease and expiration.

Only the initiating user can continue a pending login session; other authorized workspace users can see its safe status. Attempts are serialized per person/channel, rate limited to five starts per client per minute, and remote identities are unique at completion. Existing account/sender tenant reservations are preserved.

Connection claims expire after 45 seconds. Sessions expire after 10 minutes. A process crash or ambiguous provider outcome becomes **Needs review** and is not automatically replayed. Provider authentication errors are neutral; credentials and upstream response bodies are never displayed. A failed or expired attempt can be restarted after the cooldown. A connected or uncertain attempt cannot be overwritten in the portal.

An uncertain connection or workspace rebind requires operational reconciliation: inspect the exact account in the provider, confirm its client ownership, and reconcile the private attempt/reservation using a trusted service process. Do not simply delete a reservation or replay a lost Connect/OAuth result. Reconnection/disconnection and automated reconciliation are follow-up work; this release implements initial onboarding.

New-user invitation login links follow Supabase's OTP expiration (separate from the seven-day membership invitation). Existing-user invitations never expose magic links or password-reset links to the inviting administrator. Membership acceptance still checks invitation revocation, inviter authority and intended email. The existing portal’s Team screen supports invitation revocation and member management. Membership revocation should accompany cancellation if an invitation has already been accepted.

The existing frontend uses Supabase SSR sessions and project-scoped cookies. Every server action verifies the current user and workspace membership before calling the fixed backend origin with a bearer token; the backend independently verifies authorization. Invitation secrets travel in URL fragments, are removed from the address bar, and are never sent in query strings. Invitation progress is retained in per-tab session storage to survive a refresh, then cleared after acceptance; the consumed Auth login token is discarded after verification. No analytics or third-party scripts are embedded.

Migrations 0108–0109 add encrypted agency integrations, private key access, owner/version checks, assignment locks, and an append-only integration audit. Credential resolution supports saved Vault references in onboarding, inbox verification and existing reply/sync adapters; their delivery gates remain unchanged.

## Files and API boundaries

| Area | Location |
| --- | --- |
| Portal UI | Sibling `covora-outreach`: existing Accounts, Agency, login and invitation screens |
| User/API contracts | `src/lib/onboarding-contract.ts` |
| Verified bearer handlers | `src/lib/onboarding-api.ts`, `src/app/api/onboarding/` |
| Admin integration API | `src/lib/admin-integrations-api.ts`, `/api/onboarding/admin-integrations` |
| Encrypted credential resolution | `src/lib/integration-credentials.ts`, migration `0108_admin_integrations.sql` |
| Provider calls | `src/lib/onboarding-provider.ts` |
| Tenant and connection authority | `supabase/migrations/0106_outreach_onboarding.sql`, `0107_onboarding_reservation_fencing.sql` |
| Local startup | `scripts/local-portal.mjs` |
| Focused tests | `tests/unit/onboarding-provider.test.ts`, `tests/db/outreach-onboarding.test.ts` |

`GET /api/onboarding/context` returns authorized workspaces. Client/person creation, invitations, integration binding and connection operations use POST JSON bodies. People/integration reads accept one `clientId` query parameter. The connection endpoint accepts `start`, `poll`, or `pin`; users never supply provider account/session IDs or API keys.

## Verification and remaining live checks

Run the repository's required checks: unit/tooling tests, tenant/role database tests, lint, typecheck, runtime dependency audit, and production build. New coverage includes tenant isolation, role denials, new-user invitation acceptance, existing-user takeover prevention, Google identity/workspace matching, concurrent OAuth initialization, consumed-result persistence, revoked authority, LinkedIn PIN handling, disabled sender bindings and private credential filtering.

Live provider behavior remains unverified until real independent workspace credentials and HeyReach Account Login API entitlement are supplied. Before production rollout, validate one consented Google Workspace account and one consented LinkedIn account (including PIN/app verification) through the portal, and review the provider-side account ownership. Do not enable outreach delivery as part of that connection check.

References: [Instantly OAuth flow](https://developer.instantly.ai/guides/oauth-connection-flow), [HeyReach Connect](https://docs.heyreach.io/hey-reach-api/linked-in-accounts/connect), [HeyReach status](https://docs.heyreach.io/hey-reach-api/linked-in-accounts/get-account-status), [HeyReach PIN](https://docs.heyreach.io/hey-reach-api/linked-in-accounts/submit-pin), [HeyReach key check](https://docs.heyreach.io/hey-reach-api/authentication/check-api-key), [Supabase generated invitation links](https://supabase.com/docs/reference/javascript/auth-admin-generatelink).

## Admin integration verification (October 16, 2026)

The owner integration workflow is tested with simulated provider responses and isolated local Auth/SQL. Tests cover encrypted key resolution, owner/client separation, no keys in DTOs, failed replacement preserving the existing key, stale versions, revoked owner authority, blocked removal while assigned, and saved-key account onboarding. Real provider credentials were not used.

Secret storage reference: [Supabase Vault](https://supabase.com/docs/guides/database/vault).

## Shared roster and authorization (October 16, 2026)

Migrations 0110–0111 attach sending people to verified Auth identities within each client. Acceptance and active membership provisioning reconcile an existing normalized-email match, preserving its ID, name and connections. A backfill handles existing active client administrators, members and viewers. Different email addresses stay separate. Agency owners/operators are not automatically added as senders.

The user link remains stable through login-email changes. Suspension, revocation and deletion retain connection history while disabling self-connection. Deleted identities are never silently reassigned to a new user who reuses the email; such conflicts need operator review. Unverified identities cannot claim a sender. An unconfirmed identity with an active membership is linked when its email is confirmed.

Connection preparation, provider-context reads and completion independently check the linked identity, membership version, feature gate and workspace version. An unfinished assisted sign-in that predates linking is fenced and shown as needing review. Existing confirmed connections are preserved. No role change enables sending or revokes an existing provider session.

Local verification: role/tenant database regressions cover reconciliation, idempotent acceptance, self-only connections, viewer/suspended denial, in-flight fencing, email changes, new-member Auth provisioning and denied role escalation. Existing simulated Google and LinkedIn flows also pass. Browser coverage includes owner visibility, mobile layout, private invitation activation/password setup, acceptance, member controls and client isolation.
