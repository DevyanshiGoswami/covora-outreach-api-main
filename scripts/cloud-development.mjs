import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { cloudEnvironment, port } from "./cloud-development-config.mjs";

try {
  if (process.argv.length !== 2) throw new Error("Cloud development accepts no arguments or target overrides.");
  const values = parseEnv(await readFile(".env.cloud.local", "utf8"));
  const ambient = await Promise.all([".env", ".env.local", ".env.development", ".env.development.local"].map(async path => {
    try { return await readFile(path, "utf8"); } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  }));
  const env = cloudEnvironment(values, process.env, ambient);
  console.log(`Cloud development · separate test database · outreach disabled · http://127.0.0.1:${port}`);
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], { stdio: "inherit", env });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", code => { process.exitCode = code ?? 1; });
  child.on("error", () => { console.error("Could not start cloud development."); process.exitCode = 1; });
} catch {
  console.error("Cloud development refused its configuration. Follow docs/cloud-development.md; use only the dedicated development credentials. Existing files were preserved.");
  process.exitCode = 1;
}
