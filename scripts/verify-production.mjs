const portalOrigin = process.env.PRODUCTION_PORTAL_ORIGIN || "https://minasbrasilwifi.com.br";
const unifiHealthUrl = process.env.PRODUCTION_UNIFI_HEALTH_URL ||
  "https://unifiproxy.minasbrasilwifi.com.br/healthz";
const expectedSha = process.env.EXPECTED_COMMIT_SHA;
const timeoutMs = Number(process.env.PRODUCTION_VERIFY_TIMEOUT_MS || "15000");

const failures = [];

function requireHttps(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return url;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function errorMessage(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause && typeof cause === "object") {
    const code = "code" in cause ? ` (${cause.code})` : "";
    const message = "message" in cause ? `: ${cause.message}` : "";
    return `${error.message}${code}${message}`;
  }
  return error.message;
}

async function runCheck(name, fn) {
  try {
    await fn();
    console.log(`OK: ${name}`);
  } catch (error) {
    const message = `${name}: ${errorMessage(error)}`;
    failures.push(message);
    console.error(`FAIL: ${message}`);
  }
}

async function request(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "minas-brasil-production-verifier/1.0" },
  });
  const text = await response.text();
  assert(response.ok, `${response.status} ${response.statusText}; body=${text.slice(0, 160)}`);
  return { response, text };
}

let portalUrl;
let unifiUrl;
try {
  portalUrl = requireHttps(portalOrigin, "PRODUCTION_PORTAL_ORIGIN");
  unifiUrl = requireHttps(unifiHealthUrl, "PRODUCTION_UNIFI_HEALTH_URL");
  assert(
    typeof expectedSha === "string" && /^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(expectedSha),
    "EXPECTED_COMMIT_SHA must be a full 40- or 64-character hexadecimal Git revision",
  );
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "PRODUCTION_VERIFY_TIMEOUT_MS must be a positive number");
} catch (error) {
  console.error(`FAIL: verifier configuration: ${errorMessage(error)}`);
  process.exit(1);
}

await runCheck("portal liveness", async () => {
  const { response, text } = await request(new URL("/health", portalUrl));
  assert(text.trim() === "ok", `/health returned ${JSON.stringify(text.slice(0, 80))}`);
  assert(response.headers.get("content-type")?.startsWith("text/plain"), "/health is not text/plain");
});

await runCheck("portal readiness", async () => {
  const { response, text } = await request(new URL("/ready", portalUrl));
  assert(text.trim() === "ready", `/ready returned ${JSON.stringify(text.slice(0, 80))}`);
  assert(response.headers.get("content-type")?.startsWith("text/plain"), "/ready is not text/plain");
});

await runCheck("deployed build identity", async () => {
  const { response, text } = await request(new URL("/build-info.json", portalUrl));
  assert(response.headers.get("content-type")?.includes("application/json"), "/build-info.json is not JSON");
  const buildInfo = JSON.parse(text);
  assert(buildInfo.sha === expectedSha, `expected SHA ${expectedSha}, received ${JSON.stringify(buildInfo.sha)}`);
  assert(buildInfo.build === "production", `unexpected build type ${JSON.stringify(buildInfo.build)}`);
  assert(response.headers.get("cache-control")?.includes("no-store"), "/build-info.json is cacheable");
});

await runCheck("browser security headers", async () => {
  const { response, text } = await request(new URL("/", portalUrl));
  assert(response.headers.get("content-type")?.includes("text/html"), "portal root is not HTML");
  assert(/<div id=["']root["']/.test(text), "portal root does not contain the React mount point");

  const hsts = response.headers.get("strict-transport-security") || "";
  const csp = response.headers.get("content-security-policy") || "";
  assert(/max-age=\d+/.test(hsts), "Strict-Transport-Security is missing or invalid");
  assert(csp.includes("default-src 'self'"), "Content-Security-Policy default-src is missing");
  assert(csp.includes("frame-ancestors 'none'"), "Content-Security-Policy frame-ancestors is missing");
  assert(response.headers.get("x-content-type-options") === "nosniff", "X-Content-Type-Options is not nosniff");
  assert(response.headers.get("x-frame-options") === "DENY", "X-Frame-Options is not DENY");
  assert(Boolean(response.headers.get("referrer-policy")), "Referrer-Policy is missing");
  assert(Boolean(response.headers.get("permissions-policy")), "Permissions-Policy is missing");
});

await runCheck("deployed Google OAuth bundle contract", async () => {
  const { text: html } = await request(new URL("/", portalUrl));
  const scriptMatch = html.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i) ||
    html.match(/<script[^>]+src=["']([^"']+)["'][^>]+type=["']module["']/i);
  assert(scriptMatch, "portal HTML has no module bundle");
  const bundleUrl = new URL(scriptMatch[1], portalUrl);
  const { text: bundle } = await request(bundleUrl);
  assert(bundle.includes("mb_oauth_attempt_id"), "deployed bundle is missing the server-authoritative OAuth attempt marker");
  assert(bundle.includes("https://minasbrasilwifi.com.br/oauth/callback"), "deployed bundle is missing the canonical Google callback");
  assert(bundle.includes("/oauth/handoff/create"), "deployed bundle is missing captive-assistant handoff creation");
  assert(bundle.includes("/oauth/handoff/claim"), "deployed bundle is missing one-time browser handoff claiming");
  assert(bundle.includes("/oauth/continue"), "deployed bundle is missing the external-browser continuation route");
  assert(bundle.includes("intent://"), "deployed bundle is missing the Android external-browser intent");
  assert(bundle.includes("browser_fallback_url"), "deployed bundle is missing the Android HTTPS fallback");
  assert(bundle.includes("google_oauth_started"), "deployed bundle is missing Google OAuth telemetry");
  assert(!bundle.includes("rwificontroller.drogariaminasbrasil.com.br"), "deployed browser bundle contains the private controller hostname");
});

await runCheck("same-origin Edge Function readiness", async () => {
  const { response, text } = await request(
    new URL("/api/captive-portal/?route=%2Fready", portalUrl),
  );
  assert(response.headers.get("content-type")?.includes("application/json"), "Edge readiness is not JSON");
  const body = JSON.parse(text);
  assert(body.status === "ready", `unexpected Edge readiness payload ${text.slice(0, 160)}`);
  assert(body.checks?.database === true, "Edge readiness reports database unavailable");
  assert(body.checks?.unifi_credentials === true, "Edge readiness reports UniFi credentials unavailable");
  assert(body.checks?.cron_secret === true, "Edge readiness reports cron secret unavailable");
});

await runCheck("public captive bootstrap", async () => {
  const { response, text } = await request(
    new URL("/api/captive-portal/?route=%2Fbootstrap", portalUrl),
  );
  assert(response.headers.get("content-type")?.includes("application/json"), "bootstrap is not JSON");
  const body = JSON.parse(text);
  assert(body.store && typeof body.store.slug === "string", "bootstrap has no store contract");
  assert(body.consent && typeof body.consent.version === "string", "bootstrap has no consent contract");
});

await runCheck("UniFi proxy TLS and health", async () => {
  const { response, text } = await request(unifiUrl);
  assert(response.headers.get("content-type")?.includes("application/json"), "UniFi health is not JSON");
  const body = JSON.parse(text);
  assert(body.ok === true && body.service === "unifi-proxy", `unexpected UniFi health payload ${text.slice(0, 160)}`);
});

if (failures.length) {
  console.error(`PRODUCTION VERIFICATION FAILED (${failures.length} check${failures.length === 1 ? "" : "s"}).`);
  process.exit(1);
}

console.log(`PRODUCTION VERIFIED: ${expectedSha}`);
