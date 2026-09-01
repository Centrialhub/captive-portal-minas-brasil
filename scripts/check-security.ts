import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const files = [
  "src/App.tsx",
  "src/lib/api.ts",
  "src/lib/oauth-tracker.ts",
  "src/integrations/supabase/client.ts",
  "supabase/functions/captive-portal/index.ts",
  "Dockerfile",
  "unifi-proxy/Dockerfile",
  "unifi-proxy/ingress/nginx.conf.example",
  "scripts/release-gate.sh",
  "scripts/check-assets.ts",
  "scripts/verify-production.mjs",
  "scripts/verify-unifi-proxy.mjs",
  "package.json",
  "package-lock.json",
  ".dockerignore",
  ".gitignore",
];
const contents = Object.fromEntries(files.map((file) => [file, readFileSync(join(root, file), "utf8")]));
const migrationContents = readdirSync(join(root, "supabase", "migrations"))
  .filter((file) => file.endsWith(".sql"))
  .map((file) => readFileSync(join(root, "supabase", "migrations", file), "utf8"))
  .join("\n");

const checks: Array<[string, boolean]> = [
  ["OAuth capability tokens are absent from callback URLs", !/oauth\/callback\?[^\n]*(attempt_id|resume_token)/.test(contents["src/App.tsx"])],
  ["frontend has no private Supabase auth API calls", !/_notifyAllChannels/.test(contents["src/App.tsx"])],
  ["Google OAuth returns only to the canonical HTTPS callback", (contents["src/App.tsx"].match(/https:\/\/minasbrasilwifi\.com\.br\/oauth\/callback/g) || []).length >= 2 && !/redirectTo\s*[:=]\s*["']http:/.test(contents["src/App.tsx"])],
  ["embedded Google OAuth uses a one-time server-side browser handoff", /requiresExternalOAuthBrowser/.test(contents["src/App.tsx"]) && /createExternalHandoff/.test(contents["src/App.tsx"]) && /claim_oauth_browser_handoff/.test(contents["supabase/functions/captive-portal/index.ts"])],
  ["Android captive handoff opens an external browser with an HTTPS fallback", /intent:\/\//.test(contents["src/lib/oauth-tracker.ts"]) && /android\.intent\.action\.VIEW/.test(contents["src/lib/oauth-tracker.ts"]) && /browser_fallback_url/.test(contents["src/lib/oauth-tracker.ts"])],
  ["fresh captive visits do not enter callback mode from stale local state", /location\.pathname === "\/oauth\/callback"/.test(contents["src/App.tsx"]) && !/location\.pathname === "\/oauth\/callback" \|\| OAuthTracker\.isValidOAuthFlow/.test(contents["src/App.tsx"])],
  ["auth sessions are never brokered to preview editors", !/postMessage\([^\n]*(access_token|refresh_token|session|value)/i.test(Object.values(contents).join("\n"))],
  ["UniFi credentials come from runtime secrets", /Deno\.env\.get\("UNIFI_PASSWORD"\)/.test(contents["supabase/functions/captive-portal/index.ts"])],
  ["frontend does not force the matriz route", !/store\s*=\s*["']matriz["']/.test(contents["src/lib/api.ts"])],
  ["UniFi requests serialize the complete cookie jar", /serializeCookieJar\(login\.cookies \|\| \{\}\)/.test(contents["supabase/functions/captive-portal/index.ts"])],
  ["UniFi proxy consumes externally managed routes", /include \/etc\/nginx\/routes\/routes\.conf;/.test(contents["unifi-proxy/Dockerfile"])],
  ["UniFi proxy explicitly forwards request cookies", /proxy_set_header Cookie \$http_cookie;/.test(contents["unifi-proxy/Dockerfile"])],
  ["UniFi proxy passes Set-Cookie and rejects hiding it", /proxy_pass_header Set-Cookie;/.test(contents["unifi-proxy/Dockerfile"]) && /proxy_hide_header\[\[:space:\]\]\+Set-Cookie/.test(contents["unifi-proxy/Dockerfile"])],
  ["UniFi proxy drops request workers to nginx", /cat > \/etc\/nginx\/nginx\.conf[\s\S]*\nuser nginx;/.test(contents["unifi-proxy/Dockerfile"]) && !/^USER\s+/m.test(contents["unifi-proxy/Dockerfile"])],
  ["UniFi proxy uses the official root-master runtime layout", /pid \/var\/run\/nginx\.pid;/.test(contents["unifi-proxy/Dockerfile"]) && /client_body_temp_path \/var\/cache\/nginx\/client_temp;/.test(contents["unifi-proxy/Dockerfile"])],
  ["production Nginx images are pinned by digest", [contents["Dockerfile"], contents["unifi-proxy/Dockerfile"]].every((source) => /FROM nginx:1\.30\.4-alpine@sha256:[0-9a-f]{64}/.test(source))],
  ["frontend build uses a pinned glibc Node image compatible with Deno", /FROM node:24-bookworm-slim@sha256:[0-9a-f]{64} AS build/.test(contents["Dockerfile"])],
  ["frontend build copies a pinned official Deno binary", /FROM denoland\/deno:bin-2\.9\.5@sha256:[0-9a-f]{64} AS deno/.test(contents["Dockerfile"]) && /COPY --from=deno \/deno \/usr\/local\/bin\/deno/.test(contents["Dockerfile"])],
  ["Deno is not installed through an npm lifecycle script", !/"deno"\s*:/.test(contents["package.json"]) && !/node_modules\/deno/.test(contents["package-lock.json"])],
  ["Docker rejects incomplete source revisions", /40- or 64-character hexadecimal revision/.test(contents["Dockerfile"])],
  ["Docker rejects a mismatched Supabase project", /VITE_SUPABASE_URL must match the Supabase project configured in the proxy and CSP/.test(contents["Dockerfile"])],
  ["Docker accepts only a non-placeholder Supabase publishable key", /must be a Supabase sb_publishable_ key/.test(contents["Dockerfile"]) && /is still a placeholder/.test(contents["Dockerfile"])],
  ["asset validation has no unresolved OS dependency", (/stats\.subarray\(0, 8\)\.equals/.test(contents["scripts/check-assets.ts"]) && !/execSync|file --mime-type/.test(contents["scripts/check-assets.ts"])) || /apt-get install -y --no-install-recommends file/.test(contents["Dockerfile"])],
  ["UniFi TLS ingress uses the exact public hostname", /server_name unifiproxy\.minasbrasilwifi\.com\.br;/.test(contents["unifi-proxy/ingress/nginx.conf.example"])],
  ["UniFi proxy ships only the managed store routes", /location ~ \^\/\(cintra\|cula\|dpedro\|drive\|hu\|ibituruna\|joao23\|major\|matriz\|mestra\|povao\|shopping\)/.test(contents["unifi-proxy/Dockerfile"]) && /proxy_pass http:\/\/177\.85\.235\.28:8083;/.test(contents["unifi-proxy/Dockerfile"])],
  ["UniFi TLS ingress proxies only to loopback", /proxy_pass http:\/\/127\.0\.0\.1:80;/.test(contents["unifi-proxy/ingress/nginx.conf.example"])],
  ["portal emits mandatory browser security headers", [
    "Strict-Transport-Security",
    "Content-Security-Policy",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
  ].every((header) => contents["Dockerfile"].includes(`add_header ${header}`))],
  ["release Docker build has no stray context arguments", /docker build \\\r?\n\s+--build-arg/.test(contents["scripts/release-gate.sh"]) && !/docker build\s+\+/.test(contents["scripts/release-gate.sh"])],
  ["release Docker build supplies EasyPanel-compatible GIT_SHA", /--build-arg "GIT_SHA=\$COMMIT_SHA"/.test(contents["scripts/release-gate.sh"])],
  ["release requires compromised UniFi credential rotation", /UNIFI_CREDENTIALS_ROTATED/.test(contents["scripts/release-gate.sh"])],
  ["release requires Supabase leaked-password protection", /SUPABASE_LEAKED_PASSWORD_PROTECTION_ENABLED/.test(contents["scripts/release-gate.sh"])],
  ["remote verifier checks build identity, captive OAuth handoff, Android intent, and UniFi TLS health", /EXPECTED_COMMIT_SHA/.test(contents["scripts/verify-production.mjs"]) && /oauth\/handoff\/create/.test(contents["scripts/verify-production.mjs"]) && /oauth\/handoff\/claim/.test(contents["scripts/verify-production.mjs"]) && /intent:\/\//.test(contents["scripts/verify-production.mjs"]) && /UniFi proxy TLS and health/.test(contents["scripts/verify-production.mjs"])],
  ["UniFi verifier covers every managed store", ["cintra", "cula", "dpedro", "drive", "hu", "ibituruna", "joao23", "major", "matriz", "mestra", "povao", "shopping"].every((slug) => contents["scripts/verify-unifi-proxy.mjs"].includes(slug))],
  ["migrations contain no literal UniFi passwords", !/unifi_password\s*=\s*'(?!')/i.test(migrationContents)],
  ["Docker build context excludes .env", /^\.env$/m.test(contents[".dockerignore"])],
  ["git ignores .env", /^\.env$/m.test(contents[".gitignore"])],
  ["CPF values are not interpolated into logs", !/console\.(?:log|warn|error)\([^\n]*(cpfDigits|profile\?\.cpf_digits)/.test(contents["supabase/functions/captive-portal/index.ts"])],
];

const failures = checks.filter(([, passed]) => !passed).map(([name]) => name);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
for (const [name] of checks) console.log(`OK: ${name}`);
