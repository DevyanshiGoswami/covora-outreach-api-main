import test from "node:test";
import assert from "node:assert/strict";
import { cloudEnvironment, projectRef, authUrl, backend } from "../../scripts/cloud-development-config.mjs";
const jwt = (role, ref = projectRef) => `e30.${Buffer.from(JSON.stringify({role,ref})).toString("base64url")}.test`;
const valid = () => ({NEXT_PUBLIC_SUPABASE_URL: authUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt("anon"), ...(backend ? {SUPABASE_SERVICE_ROLE_KEY: jwt("service_role")} : {})});
test("cloud startup rejects production, foreign, mismatched and privileged public credentials", () => {
  for (const patch of [
    {NEXT_PUBLIC_SUPABASE_URL: "https://uuqrewifuwscnyxepjbh.supabase.co"},
    {NEXT_PUBLIC_SUPABASE_URL: `${authUrl}/`},
    {NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt("anon", "uuqrewifuwscnyxepjbh")},
    {NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt("service_role")},
    {NEXT_PUBLIC_SUPABASE_ANON_KEY: "invalid-private-value"},
    {OUTBOUND_API_ORIGIN: "https://covora.app"},
    ...(backend ? [{SUPABASE_SERVICE_ROLE_KEY: jwt("service_role", "uuqrewifuwscnyxepjbh")}] : [{SUPABASE_SERVICE_ROLE_KEY: jwt("service_role")}]),
  ]) assert.throws(() => cloudEnvironment({...valid(), ...patch}), error => !error.message.includes("invalid-private-value"));
});
test("cloud startup masks stale Next files and drops inherited application credentials", () => {
  const env = cloudEnvironment(valid(), {PATH: "/safe/path", HOME: "/home/dev", OUTREACH_REPLIES_ENABLED: "true", OUTREACH_PROVIDER_KEY: "secret", NODE_OPTIONS: "--require unsafe", NEXT_PUBLIC_PRIVATE_KEY: "secret"}, ["OUTREACH_SYNC_ENABLED=true\nOUTREACH_PROVIDER_KEY=secret\nNEXT_PUBLIC_PRIVATE_KEY=secret\nCOVORA_DEVELOPMENT_ACCESS_ENABLED=true\nNODE_OPTIONS=--require-unsafe"]);
  assert.equal(env.PATH, "/safe/path");
  assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, authUrl);
  assert.equal(env.OUTBOUND_API_ORIGIN, "http://127.0.0.1:3013");
  for (const key of ["OUTREACH_REPLIES_ENABLED", "OUTREACH_COMPOSE_ENABLED", "OUTREACH_SYNC_ENABLED", "ENABLE_OUTREACH_LEAD_ALERT_EMAILS", "COVORA_DEVELOPMENT_ACCESS_ENABLED", "OUTREACH_DEVELOPMENT_GATEWAY_ENABLED", "PASSWORD_RESET_ENABLED"]) assert.equal(env[key], "false");
  for (const key of ["CRON_SECRET", "OUTREACH_PROVIDER_KEY", "NEXT_PUBLIC_PRIVATE_KEY", "NODE_OPTIONS"]) assert.equal(env[key], "");
  if (!backend) assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, "");
});
test("cloud mode refuses hosted execution and incomplete config", () => {
  for (const env of [{VERCEL:"1"}, {CI:"true"}, {NODE_ENV:"production"}]) assert.throws(() => cloudEnvironment(valid(), env));
  assert.throws(() => cloudEnvironment({}));
});
