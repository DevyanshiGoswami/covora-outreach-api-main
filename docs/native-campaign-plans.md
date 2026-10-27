# Native campaign review plans

Campaign review plans organize existing imported leads inside the portal. They are distinct from provider campaigns, and cannot send or activate outreach. No sender, sequence, schedule, credential, provider campaign identity or activation handler is attached.

## Contracts

`GET /api/outbound/campaign-plans?clientId=<uuid>` uses the same bearer validation and current workspace membership checks as the lead directory. It returns:

```json
{
  "campaigns": [{
    "id": "<uuid>",
    "name": "Manufacturer LinkedIn",
    "audience": "hiring_partners",
    "channel": "linkedin",
    "status": "draft",
    "leadCount": 0,
    "createdAt": "<timestamp>",
    "updatedAt": "<timestamp>"
  }]
}
```

`GET /api/outbound/leads?clientId=<uuid>&planId=<uuid>` retains every existing filter and the complete neutral profile projection. It returns `selectedPlan` with the same metadata. `summary` and its `selectedPlan.leadCount` cover all currently eligible members before user filters; `total`, rows and location facets respect the additional filters. No `selectedPlan` field is added to unfiltered legacy requests. Foreign and nonexistent selected plan IDs return the same denied response.

Only GET is implemented. Connected developer access permits the read only route for its bound client, while mutations remain denied.

## Data and eligibility

Migration `0140_outreach_campaign_plans.sql` creates `outreach_campaign_plans` and `outreach_campaign_plan_memberships`. Both tables are service owned, RLS enabled and inaccessible directly to authenticated or anonymous clients. Composite tenant foreign keys prevent assigning another client's lead or campaign. The same person can belong to email and LinkedIn plans without duplicating their canonical lead record. Status is constrained to draft, and athlete email plans are prohibited.

All counts and filtered directory reads use the same current membership eligibility function. Members must remain visible, match the plan audience, and have confirmed channel identity. Email needs a verified address and valid recorded verification, including the existing strict exact mailbox recovery projection. Known relationship, identity and eligibility holds, escrow, unsubscribes, applicable bounces and suppressed conversations are excluded. Evidence gaps and role research remain visible review inventory. No predicate implies approval to send, and freshness must be checked again before any future activation feature is designed.

A service role data import can seed:

```text
outreach_campaign_plans: id, client_id, slug, name, audience, channel, status=draft
outreach_campaign_plan_memberships: plan_id, client_id, lead_id
```

No data is seeded by the migration. Provider campaign tables, sync state, worker candidates, sender versions, messages and dispatch queues are untouched. New drafts have no worker registration or dependency on provider credentials.

## Verification

Unit tests cover authenticated request projection, query validation, disabled mutation surfaces, developer client binding, malformed plan responses and inconsistent lead counts. Database tests cover all active client roles, agency reads, anonymous and cross tenant denial, raw table denial, both tenant foreign keys, duplicate membership rejection, athlete email rejection, draft only status, current identity and suppression changes, strict recovery receipts, escrow, research and location preservation, stable pagination, no duplicate people and absence of provider sync work.

Generate database types from a newly initialized isolated local schema. Never reset an existing stack. Run the complete repository unit and database suites, lint, types, runtime dependency audit and production build before release. EPM seeding is a separate guarded operation and must preserve all directory and escrow records.

## October 26 local verification receipt

The feature was checked in a newly created disposable Supabase stack named `Covora_EPM_Campaigns_20261026`, using API port 61921 and database port 61922. Local only copies of the test port guards were changed from 60321 to 61921; repository runtime guards remain unchanged. No existing stack was reset. Database types were generated from that schema.

Passed: 371 unit tests, 6 tooling tests, all 7 new campaign database tests, lint, typecheck, production build and runtime dependency audit with zero vulnerabilities. The complete database suite ran 234 tests with 232 passes. The fake transport worker failure came from the disposable copy's original port guard and passed after the local guard was updated. The followup group ran 63 tests with 62 passes, including every campaign test.

One unchanged onboarding test remains failing locally at `tests/db/outreach-onboarding.test.ts:366`: it compares a database generated expiry timestamp directly to the host `Date.now()`. A timing probe measured the database approximately 77 ms ahead of the host request midpoint over a 78 ms roundtrip. The failure reproduces outside the new feature tests; neither the onboarding code nor its test was changed. CI in a clean clock environment must pass before merge. This is a local verification limitation, not a campaign test failure.

## Campaign read performance correction

Migration `0141_outreach_campaign_plan_read_performance.sql` removes redundant counting of every plan when only one roster is requested. It materializes the selected cohort once, filters canonical imported rows before location and research projection, and reuses the resulting summary count for selected plan metadata. Provider only rows cannot be plan members and are skipped for selected plan reads. The selected name retains the existing neutral display projection.

Local EXPLAIN on the exact 2,545 row EPM fixture did not confirm repeated per row execution of the eligibility function. The initial generic authenticated RPC took 219 ms and 130,000 shared buffer hits. After removing redundant work it took 88 ms and 41,456 shared buffer hits. These are local measurements, not claimed production timing. Five complete response comparisons covering the unfiltered directory, all three plans and additional pages were identical, with totals 2,372, 1,232, 598 and 985 preserved. All eight campaign database tests pass, including six calls through one forced generic plan for 1,400 members under a five second database statement timeout. Lint and typecheck also pass. Production timing and completion remain a separate release verification.
