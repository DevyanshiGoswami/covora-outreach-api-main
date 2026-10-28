# Initial assigned-campaign results backfill

`scripts/backfill-assigned-campaigns.ts` imports metadata, sequence copy, daily results and all available lead pages for one reviewed client. It only updates existing campaign assignments. It does not access email messages, send mail, enable sending, change accounts or memberships, or write the normal worker's sync state/cursors.

The operator supplies credentials through the process environment, using the same dedicated database and named provider credential configuration as the backend. The tool never reads an environment file or a credential file and never prints their values. The database must be the independent Outbound project `uuqrewifuwscnyxepjbh`; local or content-portal targets are rejected.

Supply a reviewed JSON manifest with exactly these keys:

```json
{
  "projectRef": "uuqrewifuwscnyxepjbh",
  "clientId": "<assigned client UUID>",
  "remoteWorkspaceId": "<verified provider workspace UUID>",
  "campaignIds": ["<each reviewed provider campaign UUID>"],
  "senderAddresses": ["<each reviewed sender email>"]
}
```

The campaign and sender sets must exactly match that client's database assignments. For the reviewed DioWave rollout record, map `workspaceId` to `remoteWorkspaceId`, `campaigns[].providerId` to `campaignIds`, and `senders` to `senderAddresses`. Do not include the credential reference or additional fields in this manifest; the reference is read from the verified client binding.

From the backend checkout, with private environment values already loaded:

```sh
NODE_OPTIONS=--conditions=react-server ./node_modules/.bin/tsx scripts/backfill-assigned-campaigns.ts /absolute/path/manifest.json --check
NODE_OPTIONS=--conditions=react-server ./node_modules/.bin/tsx scripts/backfill-assigned-campaigns.ts /absolute/path/manifest.json --apply
```

`--check` reads the provider's full campaign/lead data and reports projected counts without database mutations. `--apply` writes the normal neutral result projections. Provider requests are sequential and paced at least one second apart. Each run has a 20-minute limit, a global 1,000-lead-page limit, and at most 50 campaigns. An unavailable or malformed response stops the run; absent counts are not fabricated to finish it.

Apply mode acquires the existing synchronization lease and renews it for 300 seconds before every provider attempt and write. An active worker causes the tool to stop; do not take over its lock. The ordinary worker defers while the import owns that lease. Assignment, feature, workspace and sender configuration are rechecked before writes. The lock is released on completion or failure and expires after an interrupted process.

Campaign results receive `synced_at` only after that campaign's lead pagination finishes. The output lists completed campaigns by internal ID and row counts. Earlier upserts remain after an error and can safely be repeated with the same manifest. Normal worker checkpoints stay unchanged, so the next regular run independently refreshes its own history and resumes normal scheduling. This initial importer adds/updates sequence rows; the regular worker remains responsible for pruning sequence variants removed from the provider.

A senderless draft imports only its real campaign results and leads. Its reported reply count may be nonzero even though sender authorization is insufficient to read its historical messages. No result import implies sending readiness.
