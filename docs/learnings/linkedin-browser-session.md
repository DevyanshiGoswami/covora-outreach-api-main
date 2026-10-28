# LinkedIn browser-session connections

## Symptom

The local portal offered only password and verification-code sign-in. Users also need to connect an existing LinkedIn browser session.

## Root cause

The provider adapter supported Connect but not ConnectWithCookies. A cookie session does not prove the supplied email identity, so adding another transport call alone would not be sufficient.

## Approach that worked

- Accept a separate, strict cookie start payload behind the existing bearer and person authorization checks. Forward only li_at and JSESSIONID, bounded to two 2-KiB printable values. No raw cookie export, password, custom proxy or arbitrary transport URL is accepted.
- The frontend removes tracking cookies and extension metadata. The backend independently validates names, domain, path, lengths, country, browser context and expected profile URL before claiming an attempt.
- Migration 0122 adds only the expected public profile URL to the existing connection record. A wrapper reuses person authority, identity reservations, rate limits and leases. Duplicate starts never repeat the provider call or replace the expected profile.
- ConnectWithCookies receives the session once with the current browser user agent, country and existing inbox scope. Polls use the saved remote account ID; profile matching is checked by the adapter and again by the SQL completion function. No sender is enabled for campaign execution.
- Cookies never enter SQL, logs, response DTOs or persistent frontend storage. Public errors use fixed codes. A lost start stays uncertain; it is not automatically retried.

## Rule for next time

A browser session can belong to another account. Preserve an explicit expected public profile before connecting and match it before recording success. Keep credentials out of retry requests, leases, audits and action responses.

Apply 0122 before deploying the backend, then the frontend. Existing password and Google/Microsoft flows remain compatible. This release was applied only to the isolated local real-account test stack; cloud deployment was not performed.

## Evidence

- 307 backend unit tests and 6 tooling tests passed; lint, typecheck, production build and runtime audit passed (0 vulnerabilities).
- The fresh Covora_Linkedin_Cookie_Test stack (API 59321) ran all 161 database tests: 160 initially passed. One unrelated worker fixture refused the nondefault local port. Adjusting the allowlisted port in the temporary test copy only made that test pass. An additional lost-cookie-response/rebinding regression passed, for 162 covered database tests. Repository runtime target guards were unchanged.
- Database tests cover malformed cookies, foreign tenants, viewers, private table/RPC grants, duplicate calls, profile mismatch and disabled sender creation. Existing team self-connection and account verification regressions passed.
- Browser checks used simulated provider transport: connection and refresh, profile mismatch, forbidden API access, uncertainty without replay, password/PIN, viewer restrictions, validation, secret clearing and mobile layout.
- Local UI and migration 0122 verified on the user's existing test stack (65321); provider traffic was not initiated during that check. Real cookie compatibility and the workspace's Account Login API entitlement still require the user's own session test.

## References

- https://docs.heyreach.io/hey-reach-api/linked-in-accounts/connect-with-cookies
- https://docs.heyreach.io/hey-reach-api/linked-in-accounts/connect
- https://help.heyreach.io/en/articles/9877938-how-to-connect-my-linkedin-account-to-heyreach

The generated endpoint examples contain a malformed base URL and contradictory required-field markers. Use the established api.heyreach.io origin, the documented country/custom-proxy choice, and a real browser user agent. No custom proxy is sent with the country option.
