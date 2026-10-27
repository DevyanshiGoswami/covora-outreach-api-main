# ClickUp authorization

## Scope

The Leads page connects ClickUp for the selected Covora client. This release only
exchanges an authorization code, confirms the authorized Workspaces, and saves
the credential encrypted in Vault. It never reads CRM tasks or transfers leads.
Client administrators and explicit agency owners may manage the connection.
Members, viewers and assigned operators can see connection metadata only.

## Register the Covora application

A ClickUp Workspace owner or administrator registers **one Covora OAuth app**:

1. In ClickUp, open avatar → Settings → Apps → Create new app.
2. Name it Covora and register this exact production redirect URL:
   `https://covora.app/auth/clickup/callback`.
3. In Covora, open Agency → Integrations → ClickUp → Set up ClickUp.
   Copy the displayed redirect URL into the ClickUp app registration. Save the
   Client ID and Client Secret in Covora's form. The secret is encrypted in Vault,
   never returned to the browser, and cannot be viewed after saving.
4. `CLICKUP_REDIRECT_URI` is the deployment-owned callback (defaults to
   `https://covora.app/auth/clickup/callback`). Set it on the backend for local or
   test deployments. The form cannot override this destination. Legacy backend
   `CLICKUP_CLIENT_ID` / `CLICKUP_CLIENT_SECRET` remain a fallback only until the
   first admin save or disable; admin settings take precedence thereafter.
5. Apply migrations `0138_clickup_authorization.sql` and
   `0139_clickup_admin_app.sql` through the reviewed release process, then deploy
   backend and frontend. Production changes require separate authorization.
6. Sign into Covora with a client administrator or agency owner account, select the
   intended client, open Leads, and choose Connect to ClickUp → Continue to ClickUp.
   Sign into the test ClickUp account and authorize only the intended Workspaces.
7. Confirm the returned Workspace names. No lead sync should start. Disconnect
   removes the stored token; revoke Covora in ClickUp settings to remove the
   provider-side authorization too.

For an isolated local test, register the exact local callback instead and use a
separate test OAuth app. The implementation accepts `http://127.0.0.1:<port>` only
outside production. A public HTTPS test deployment is another option. Never mix
a production callback with a different local browser session. The connected local
development gateway exposes only Covora's connection metadata; OAuth changes use
the deployed portal or a fully isolated local backend.

An ordinary ClickUp account can test consent. Registering the app additionally
requires Workspace owner/admin access. Clients authorize our app; they do not
need to create their own app or share their personal API tokens.

## App administration

- Only active agency owners can read app metadata or save/disable settings.
  Connected development sessions cannot access these endpoints.
- Saving validates format and stores credentials; it does not verify them with
  ClickUp. The UI says Configured, and a client consent round trip is the check.
- App updates use an expected version and recheck the owner's membership version
  inside SQL. Rotation atomically replaces the encrypted secret.
- App version is bound to every OAuth attempt and checked at start, consume and
  completion, including a change during the provider exchange.
- Replacing the app's Client ID is blocked while clients have saved grants.
  Disable deletes the app secret and stops new authorizations without deleting
  existing client grants or revoking ClickUp's permission. Re-enabling the same
  app is supported. An explicit disable never falls back to environment keys.

## Security and behavior

- Fixed ClickUp authorization, token and Workspace endpoints; no arbitrary redirects.
- Random 256-bit state, hashed server storage, ten-minute expiration, one-time use.
- Separate HttpOnly, SameSite=Lax browser proof cookie, Secure in production.
- Start/callback bind client and authenticated actor. Membership/owner versions,
  feature gate and connection generation are rechecked before saving.
- Reconnect rotates the Vault secret atomically. Disconnect invalidates pending
  attempts. Client deletion removes the encrypted token.
- Tokens, authorization codes, raw provider errors and remote identifiers never
  enter connection DTOs. Workspace membership lists are discarded.
- OAuth callback immediately redirects to a clean Leads URL with no-referrer and
  no-store headers. Configure hosting request-log redaction for callback query
  parameters (`code` and `state`); do not enable body logging on this API.
- The popup distinguishes Workspace authorization from what Covora uses now.
  ClickUp's documented flow does not provide a lead-only read scope or enforce
  future List selection. Add explicit List restrictions before any data sync.
- “Connected” records saved authorization, not continuous provider health or sync.

## Verification

Unit tests cover exact endpoints, safe callbacks, malformed grants and projection.
Database/API tests cover role and tenant denial, browser/state mismatch, expired
and replayed callbacks, superseded attempts, membership changes, feature removal,
private table/function grants, and disconnect. Browser checks use simulated ClickUp
responses and real isolated Covora authentication; a real provider consent check
requires the registered OAuth app.

## References

- https://developer.clickup.com/docs/authentication
- https://developer.clickup.com/reference/getaccesstoken
- https://developer.clickup.com/reference/getauthorizedteams
