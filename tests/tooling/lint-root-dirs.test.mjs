import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { Linter } from "eslint";

const require = createRequire(import.meta.url);
const nextPlugin = require("@next/eslint-plugin-next");
const { getRootDirs } = require("@next/eslint-plugin-next/dist/utils/get-root-dirs.js");
const pluginRequire = createRequire(require.resolve("@next/eslint-plugin-next"));

test("Next lint adapter fails visibly if its caller changes the required API", () => {
  const { globSync } = pluginRequire("fast-glob");
  for (const [pattern, options] of [
    [[], { onlyDirectories: true }],
    [".", { onlyDirectories: false }],
    [".", { onlyDirectories: true, cwd: "." }],
    [".", undefined],
  ]) {
    assert.throws(() => globSync(pattern, options), /Review the Next lint glob adapter/);
  }
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "outreach-lint-roots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of [
    "packages/client/pages/about.jsx",
    "packages/client/nested/pages/unrelated.jsx",
    "packages/admin/src/pages/reports.jsx",
    "packages/archived/pages/old.jsx",
    "packages/README.md",
  ]) {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "export default function Page() { return null; }");
  }
  return root;
}

function roots(rootDir, cwd = process.cwd()) {
  return getRootDirs({ cwd, settings: { next: { rootDir } } })
    .map((path) => resolve(path))
    .sort();
}

test("Next lint explicit roots stay within the selected project", async (t) => {
  const root = await fixture(t);
  const client = join(root, "packages/client");
  assert.deepEqual(roots(undefined, client), [client]);
  for (const path of [client, `${client}/`, relative(process.cwd(), client), client.replaceAll("/", "\\")]) {
    assert.deepEqual(roots(path), [client]);
  }
  assert.deepEqual(roots(join(root, "missing")), []);
  assert.deepEqual(roots(join(root, "packages/README.md")), []);
});

test("Next lint expands directory globs and arrays without adding descendant projects", async (t) => {
  const root = await fixture(t);
  const client = join(root, "packages/client");
  const admin = join(root, "packages/admin");
  const archived = join(root, "packages/archived");
  assert.deepEqual(roots(join(root, "packages/*/")), [admin, archived, client]);
  assert.deepEqual(roots([client, join(root, "packages/adm*")]), [admin, client]);
  assert.deepEqual(roots(join(root, "packages/clien?")), [client]);
  assert.deepEqual(roots(join(root, "packages/**/src")), [join(admin, "src")]);
  assert.deepEqual(roots(join(root, "packages/**")), [
    "admin", "admin/src", "admin/src/pages", "archived", "archived/pages",
    "client", "client/nested", "client/nested/pages", "client/pages",
  ].map((path) => join(root, "packages", path)));
});

test("Next lint preserves separate negative root entries and rejects unsupported syntax", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(roots(`!${root}/packages/archived`), []);
  // Next evaluates array entries separately, so these are not cross-entry exclusions.
  assert.deepEqual(roots([`${root}/packages/*`, `!${root}/packages/archived`]), [
    join(root, "packages/admin"),
    join(root, "packages/archived"),
    join(root, "packages/client"),
  ]);
  for (const pattern of ["!(archived)", "(client|admin)", "@(client|admin)", "{client,admin}", "client{1..12}", "client{1..3..2}", "client[12]"]) {
    assert.throws(() => roots(join(root, "packages", pattern)), /Unsupported Next rootDir syntax/);
  }
});

test("Next lint preserves explicit hidden roots, wildcard dot exclusion, and symlink directories", async (t) => {
  const root = await fixture(t);
  const hidden = join(root, "packages/.hidden");
  const linked = join(root, "packages/linked");
  await mkdir(join(hidden, "pages"), { recursive: true });
  await symlink(join(root, "packages/client"), linked, "dir");
  assert.deepEqual(roots(hidden), [hidden]);
  assert.deepEqual(roots(join(root, "packages/.*")), [hidden]);
  assert.deepEqual(roots(linked), [linked]);
  const wildcard = roots(join(root, "packages/*"));
  assert.ok(wildcard.includes(linked));
  assert.ok(!wildcard.includes(hidden));
  assert.deepEqual(roots(join(root, "packages/linked/**/pages")), [
    join(linked, "nested/pages"), join(linked, "pages"),
  ]);
});

test("Next internal-link rule catches selected pages without importing nested projects", async (t) => {
  const root = await fixture(t);
  const client = join(root, "packages/client");
  const ruleId = "@next/next/no-html-link-for-pages";
  const source = 'export default function Page() { return <><a href="/about">About</a><a href="/unrelated">Other project</a><a href="https://example.com/about">External</a><Link href="/about">Valid</Link></>; }';
  for (const rootDir of [client, join(root, "packages/cl*")]) {
    const messages = new Linter().verify(source, [{
      files: ["**/*.jsx"],
      languageOptions: {
        parserOptions: { ecmaVersion: 2022, sourceType: "module", ecmaFeatures: { jsx: true } },
      },
      plugins: { "@next/next": nextPlugin },
      settings: { next: { rootDir } },
      rules: { [ruleId]: "error" },
    }], { filename: "fixture.jsx" });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].ruleId, ruleId);
    assert.match(messages[0].message, /navigate to `\/about\/`/);
  }
});
