import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { projectRef } from './cloud-development-config.mjs';

const apply = process.argv.length === 3 && process.argv[2] === '--apply';
if (process.argv.length !== 2 && !apply) throw new Error('Use db:cloud for a plan, or db:cloud -- --apply. Target overrides are not accepted.');
const temporary = mkdtempSync(join(tmpdir(), 'covora-dev-migrations-'));
function query(sql) {
  const file = join(temporary, 'query.sql');
  writeFileSync(file, sql, { mode: 0o600 });
  try {
    return JSON.parse(execFileSync('node_modules/.bin/supabase', ['db', 'query', '--linked', '--project-ref', projectRef, '--file', file, '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10_000_000 })).rows;
  } catch { throw new Error('Development migration query failed. No production target was used. Inspect the development database before retrying.'); }
}
const literal = value => "'" + value.replaceAll("'", "''") + "'";
try {
  const exists = query("select to_regclass('supabase_migrations.schema_migrations') is not null as present")[0].present;
  const history = exists ? query('select version, name, statements from supabase_migrations.schema_migrations order by version') : [];
  const files = readdirSync('supabase/migrations').filter(file => /^\d+_.+\.sql$/.test(file)).sort();
  const migrations = files.map(file => ({file, version:file.split('_')[0], name:file.replace(/^\d+_/, '').replace(/\.sql$/, ''), sql:readFileSync(join('supabase/migrations', file), 'utf8')}));
  for (const entry of history) {
    const local = migrations.find(m => m.version === entry.version);
    if (!local || entry.statements?.length !== 1 || entry.statements[0] !== local.sql) throw new Error('Development migration history differs from this checkout. Pull the reviewed branch; never reset the shared database.');
  }
  const pending = migrations.filter(m => !history.some(h => h.version === m.version));
  console.log(`Development database ${projectRef}: ${history.length} applied, ${pending.length} pending.`);
  pending.forEach(m => console.log(m.file));
  if (apply && pending.length) {
    // One transaction and lock: concurrent or stale plans fail instead of partially applying.
    const sql = `begin; select pg_advisory_xact_lock(82941028);
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations(version text primary key, statements text[], name text);
do $guard$ begin if (select count(*) from supabase_migrations.schema_migrations) <> ${history.length} then raise exception 'Migration plan changed'; end if; end $guard$;
` + pending.map(m => `${m.sql}\ninsert into supabase_migrations.schema_migrations(version,name,statements) values(${literal(m.version)},${literal(m.name)},array[${literal(m.sql)}]);`).join('\n') + '\ncommit;';
    query(sql);
    console.log(`Applied ${pending.length} migrations to development. Schema fingerprint: ${createHash('sha256').update(migrations.map(m=>m.sql).join('\n')).digest('hex')}`);
  } else if (pending.length) console.log('Review this plan, then run npm run db:cloud -- --apply.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { rmSync(temporary, { recursive: true, force: true }); }
