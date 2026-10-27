# Client-owned ClickUp authorization

## Symptom

The first CRM connection needs to be reusable without beginning a data sync or
sharing one client's authorization with another client.

## Root cause

An agency-wide provider credential model is unsuitable for client-owned CRM
consent. Provider authorization also grants broader access than today's feature.

## Approach that worked

Use a client-bound authorization table and encrypted Vault credential. Bind a
single-use state to the authenticated actor, role version, browser proof and
connection generation. Recheck those grants after the provider round trip.
Keep consent metadata separate from future List mappings and sync jobs.

## Rule for next time

Describe the actual provider grant separately from the operations the product
currently performs. Client configuration must never imply a narrower OAuth scope
than the provider enforces. Deleting/disconnecting a connection must fence any
pending callback as well as remove its saved credential.

## Evidence

`tests/db/clickup-authorization.test.ts`, `tests/unit/clickup-api.test.ts`, migration
0138, and `docs/CLICKUP-AUTHORIZATION.md`. Real ClickUp consent is pending app setup;
provider calls in automated/browser checks are simulated.
