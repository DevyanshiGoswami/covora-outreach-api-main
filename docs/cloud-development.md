# Shared cloud development

Run the frontend and API on your laptop against the separate `covora-outreach-dev`
database. Docker is not needed for normal application development. This is shared
**test data**: edits are visible to other developers, but do not affect production.

## First setup

Use Node 22. Install dependencies with `npm ci` in both repositories. Ask the
maintainer for your separate development login and the private development config
for each repository; production passwords do not carry over.

Save the backend config as `.env.cloud.local` in this repository:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://qrfboszixzjwkhkgzyjl.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<development project-bound anon key>
SUPABASE_SERVICE_ROLE_KEY=<development project-bound service key>
```

The frontend's `.env.cloud.local` contains only the first two fields. Never put
the service key in the frontend. Keep both files private and out of Git.

Start this repository with `npm run dev:cloud` (API: `http://127.0.0.1:3013`).
Start the frontend repository with `npm run dev:cloud`, then open
`http://127.0.0.1:3003/login` and use your **development** login. A green development
banner identifies the shared test environment. Ports intentionally differ from
existing Docker/live development sessions. Both processes must be running.

The launcher pins the development project and validates both credentials' project
and role. It ignores inherited application environment variables and masks stale
Next `.env` values without changing those files. Real sending, synchronization,
cron access, notifications, password-recovery emails and the live development
gateway are disabled. No production integration credentials are copied. Do not
configure real integrations or import customer data into this database.

## Schema changes

The project uses the same migration files as production, with separate Auth,
rows, storage and credentials. There is no ongoing production-data replication.
All 59 migrations through `0148` were initially applied on October 28, 2026.

One maintainer applies reviewed migrations from the agreed branch:

```sh
npm run db:cloud
npm run db:cloud -- --apply
```

The first command is a read-only plan; the second applies pending migrations in
one transaction to the pinned development project. Both use your separately
authenticated management CLI. Migration history is checked against file contents;
changed or missing applied files are refused. If a teammate has migrated ahead,
pull their reviewed migrations before continuing. Never reset this shared database
or run destructive database tests against it. CI and database regression tests
continue to use disposable isolated Docker stacks. Application unit tests do not
require Docker.

## Add a developer

A maintainer with the private development backend config runs:

```sh
npm run seed:cloud -- developer@example.com
```

This creates a separate confirmed Auth login with an agency-owner role **only in
development**, and adds synthetic example.test leads to two development workspaces.
It sends no email, never resets an existing user's password and never overwrites
edited sample rows. The random password is saved in a private, ignored
`.artifacts/cloud-login-<email>.json`; give that file only to its developer. The
backend config grants administrative access to this development database, so share
it only with trusted backend developers. Frontend-only developers need public
config and a local API provided by their team.

If provisioning fails after Auth creation, keep the login file and repair the
membership in development; rerunning deliberately does not reset the account.

## Operations and cost

Project: `qrfboszixzjwkhkgzyjl`, US West, Micro compute. Provisioned through the
existing marketplace Pro installation at approximately **$10/month additional**
compute, plus applicable usage overages and tax. No extra hosting project or Pro
subscription was created. No production deployment is attached to the dev store.

Password login is available. The connected management credential was denied Auth
configuration writes. An organization owner should set Auth Site URL to
`http://127.0.0.1:3003`, add loopback redirect URLs, disable public sign-ups, and set
the minimum password length to 12. These dashboard changes remain pending; normal
password login does not require redirects. The portal has no public signup flow,
new Auth identities alone grant no workspace access, and recovery emails stay off.

Production access remains a separate, explicit workflow. `dev:connected` in the
frontend uses live data; `dev:cloud` is the default choice for safe feature work.
