import { parseEnv } from "node:util";

export const projectRef = "qrfboszixzjwkhkgzyjl";
export const authUrl = `https://${projectRef}.supabase.co`;
export const backend = true;
export const port = 3013;

function credential(value, role) {
  try {
    if (typeof value !== "string" || value.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const payload = JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString());
    if (payload.ref !== projectRef || payload.role !== role) throw new Error();
    return value;
  } catch { throw new Error("Use the project-bound development credentials from your private setup file."); }
}

// Deliberately narrow: cloud mode never inherits application credentials or jobs.
export function cloudEnvironment(values, inherited = {}, ambientFiles = []) {
  if (inherited.VERCEL || inherited.CI || inherited.NODE_ENV === "production") throw new Error("Cloud development runs locally only.");
  const allowed = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", ...(backend ? ["SUPABASE_SERVICE_ROLE_KEY"] : [])];
  if (Object.keys(values).some(key => !allowed.includes(key)) || allowed.some(key => !values[key])) throw new Error("The cloud configuration has missing or unsupported fields.");
  if (values.NEXT_PUBLIC_SUPABASE_URL !== authUrl) throw new Error("Cloud development requires the dedicated development database.");
  const publicKey = credential(values.NEXT_PUBLIC_SUPABASE_ANON_KEY, "anon");
  const serviceKey = backend ? credential(values.SUPABASE_SERVICE_ROLE_KEY, "service_role") : "";
  // Next also loads .env files. Mask every key there, without modifying those files.
  const masked = Object.fromEntries(ambientFiles.flatMap(text => Object.keys(parseEnv(text)).map(key => [key, ""])));
  const osKeys = ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "COMSPEC", "PATHEXT", "TERM", "COLORTERM", "LANG", "LC_ALL", "TZ"];
  const system = Object.fromEntries(osKeys.filter(key => inherited[key] !== undefined).map(key => [key, inherited[key]]));
  return { ...masked, ...system, NODE_ENV: "development", COVORA_CLOUD_DEVELOPMENT: "true",
    NEXT_PUBLIC_APP_NAME: "Covora · Development", NEXT_PUBLIC_SUPABASE_URL: authUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: publicKey, SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    OUTREACH_SUPABASE_PROJECT_REF: projectRef, OUTBOUND_API_ORIGIN: "http://127.0.0.1:3013",
    OUTREACH_PORTAL_ORIGIN: "http://127.0.0.1:3003", OUTREACH_REPLIES_ENABLED: "false",
    OUTREACH_COMPOSE_ENABLED: "false", OUTREACH_SYNC_ENABLED: "false", ENABLE_OUTREACH_LEAD_ALERT_EMAILS: "false",
    OUTREACH_DEVELOPMENT_GATEWAY_ENABLED: "false", COVORA_DEVELOPMENT_ACCESS_ENABLED: "false",
    OUTREACH_ONBOARDING_WORKSPACES: "[]", CRON_SECRET: "", PASSWORD_RESET_ENABLED: "false",
    CLICKUP_CLIENT_ID: "", CLICKUP_CLIENT_SECRET: "", CLICKUP_REDIRECT_URI: "",
  };
}
