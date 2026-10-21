# LinkedIn location rejection was mislabeled as an expired browser session

## Symptom
A real browser-session attempt returned HTTP 400 before a remote account ID. The portal told the user to export fresh cookies, although bounded diagnostics found a country/proxy rejection and no session rejection.

## Root cause
The adapter treated every cookie-start HTTP 400/422 as an invalid session. It also forwarded uppercase country codes from the portal. A live read-only GetProxyCountries request returned lowercase values, including `us`, `in` and `gb`, while the documentation examples use uppercase. This is a confirmed representation mismatch; whether capitalization alone caused the real rejection still requires the user's next sign-in attempt.

## Approach that worked
Both password and browser-session requests now send the selected country in lowercase, matching the live catalog. No country or proxy is chosen automatically. A bounded 16 KiB error reader inspects only recognized error fields or plain error text, returning fixed codes for location, explicit session rejection or unknown request rejection. Error bodies and request secrets never reach logs or client responses. Location errors no longer instruct the user to replace cookies.

## Rule for next time
Distinguish an HTTP rejection from the reason for it. Verify catalog values at the API boundary, even when sample docs disagree. Never automatically replay a connection request to diagnose it.

## Evidence
310 backend unit tests and 6 tooling tests passed, plus 30 account onboarding and tenant/role database tests on fresh `Covora_Linkedin_Location_Test` (57321/57322). Tests verify lowercase country routing for both methods, bounded JSON/plain error classification, no secret leakage and no automatic retries. Lint, types, runtime audits and builds passed for both repos; frontend boundary and 180 tests passed. Browser regression results are recorded with the local test artifacts. No schema or production changes. Real-provider acceptance remains a user test.

Official references checked October 21, 2026:
- https://docs.heyreach.io/hey-reach-api/linked-in-accounts/get-proxy-countries
- https://docs.heyreach.io/hey-reach-api/linked-in-accounts/connect-with-cookies
