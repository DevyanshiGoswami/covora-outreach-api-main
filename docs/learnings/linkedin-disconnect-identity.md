# LinkedIn disconnect identity

## Cause

A verified LinkedIn sender can have a different primary email in `GetById`
from the email used for the original credential login. The former disconnect
check required them to match, blocking legitimate removal before DELETE.

## Change

The leased, service-only disconnect RPC now includes the profile recorded when
the connection succeeded, scoped by client, channel, remote sender and workspace
binding. The adapter verifies both the exact remote account ID and that saved
profile before removal. It never accepts a profile supplied by the disconnect
request. If the saved profile is unavailable, the old strict email check remains;
missing evidence cannot authorize removal of an email alias.

Missing, malformed or different provider profiles block removal when a saved
profile exists, even when the emails match. Profile normalization uses the same
LinkedIn URL validator as browser-session connections.

Campaign checks and `force=false` remain. A timeout after DELETE stays uncertain;
status checks never repeat DELETE, and the reservation is released only after
confirmed absence. Existing permissions, leases, tenant and reply fences remain.

## Verification

Provider tests cover alternate/missing primary email, profile normalization,
wrong account/profile, missing evidence, active campaigns and uncertain deletion.
Database/API tests cover the service-only profile lookup, claim/workspace
invalidation, denied users, mismatched profiles, exact-sender deletion and
reservation release. No authentication secrets are recorded by these tests.

Provider contract: https://docs.heyreach.io/hey-reach-api/linked-in-accounts/get-by-id
and https://docs.heyreach.io/hey-reach-api/linked-in-accounts/remove-account.
