# Account connections release — 22 October 2026

## Symptom

The local account-connection branch had not reached production. Main already contained the EPM Comments schema at migration 0121, which conflicted with the local branch's rejected-email migration.

## Root cause

Local connection work and a separate production feature advanced independently. The local recovery implementation also removed failed/expired LinkedIn senders automatically, even though a connection can still require verification outside Covora.

## Approach that worked

- Merge current main into the release branch, preserving the EPM Comments API and schema.
- Keep production migration 0121 unchanged. Release all eight unpublished connection migrations as 0122–0129, in their original dependency order. Local test databases with the earlier numbering must not replay this sequence or have their histories blindly repaired.
- Remove automatic external-account deletion from recovery. A user must deliberately disconnect an account through the guarded removal flow. Failed sender seats may need explicit management in the service dashboard.
- Recover a lost LinkedIn sender only when its login has one matching sender; ambiguous matches remain unresolved. Reject recovery or email switching after the saved provider-workspace version changes.
- Generate public database types from the complete combined schema on a fresh disposable database.

## Rule for next time

Compare both the production migration history and current main before releasing a long-running feature branch. Treat an API-accepted login as an in-progress operation. A failed local state is not authorization to delete an external sender.

## Release sequence

1. Verify the existing dedicated production projects and save their deployment revisions.
2. Require frontend quality and backend static/database CI checks on the final release revisions.
3. Apply only migrations 0122–0129 to the dedicated outbound database in one transaction with migration-history entries. Do not change client membership, provider keys, sending gates or Comments configuration.
4. Merge/deploy the backend and check health and authentication denial.
5. Merge/deploy the frontend and verify the production alias, auth redirect and account UI.

## Evidence and limitations

Unit, type, lint, dependency, build, isolated database and browser results are recorded with the release PRs. Live provider consent remains a user action; synthetic tests do not establish that LinkedIn will accept a particular password, browser session or verification challenge.

The existing production aliases are `covora-outreach-api.vercel.app` and `covora.app`, backed by the dedicated outbound database. The separate content portal is excluded. Before the new controls are used, the prior application deployments can be restored while leaving additive schema in place; after connection/removal activity, prefer a forward fix over reverting to code that does not understand those states.
