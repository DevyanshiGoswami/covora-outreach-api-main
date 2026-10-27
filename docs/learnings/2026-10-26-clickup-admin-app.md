# ClickUp app administration

## Symptom

Client OAuth was blocked until an administrator edited backend environment files.
Users expected a setup card beside the existing admin integrations.

## Root cause

The client consent flow existed, but shared OAuth app registration settings had
no admin UI. App credentials and per-client access tokens are different records.

## Approach that worked

Add an owner-only ClickUp card with registration instructions, a fixed copyable
callback, password secret entry, safe metadata, and explicit disable. Store app
credentials in Vault through versioned RPCs. Preserve per-client grants and bind
in-progress consent attempts to the exact app configuration version. Treat saved
settings as Configured until a real consent round trip confirms the credentials.

## Rule for next time

Implement shared application setup alongside client authorization. Keep client
grants separate and invalidate pending authorizations on credential rotation.
Never accept callback destinations from the setup form or expose saved secrets.

## Evidence

Focused role/tenant tests cover private credential RPC denial, stale edits,
revoked owners, app changes during exchange, encrypted-secret deletion, and
preservation of existing client grants on disable. Browser checks and build
results are recorded in the task handoff. Real ClickUp consent still requires
registered app credentials.

Verification completed: 223 frontend tests, 368 backend unit tests plus 6 tooling
tests; types, lint (one pre-existing frontend unused-import warning), source
boundary, dependency audits (zero findings), and both production builds passed.
The fresh database suite passed 227/228 initially; the remaining worker test was
blocked by the test copy's fixed local port. Adapting that copy's runtime port to
60421 made the focused recheck pass. Product runtime restrictions were unchanged.
Browser checks passed on desktop/mobile for owner login, all three integration
cards, setup form, secret non-redisplay, save, client consent redirect, and disable.
The consent destination was intercepted with synthetic app credentials; no real
ClickUp authorization or CRM transfer was performed.
