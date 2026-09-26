import { createHash } from "node:crypto";

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

async function request(url, { expectedStatus, headers = {}, redirect = "follow" } = {}) {
  const response = await fetch(url, {
    redirect,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "minas-brasil-production-verifier/1.0", ...headers },
  });
  const text = await response.text();
  assert(expectedStatus === undefined ? response.ok : response.status === expectedStatus,
    `${response.status} ${response.statusText}; body=${text.slice(0, 160)}`);
  return { response, text };
}

function assertBrowserSecurityHeaders(response) {
  const hsts = response.headers.get("strict-transport-security") || "";
  const csp = response.headers.get("content-security-policy") || "";
  assert(/max-age=\d+/.test(hsts), "Strict-Transport-Security is missing or invalid");
  assert(csp.includes("default-src 'self'"), "Content-Security-Policy default-src is missing");
  assert(csp.includes("script-src 'self'"), "Content-Security-Policy script-src is missing");
  assert(csp.includes("frame-ancestors 'none'"), "Content-Security-Policy frame-ancestors is missing");
  assert(response.headers.get("x-content-type-options") === "nosniff", "X-Content-Type-Options is not nosniff");
  assert(response.headers.get("x-frame-options") === "DENY", "X-Frame-Options is not DENY");
  assert(Boolean(response.headers.get("referrer-policy")), "Referrer-Policy is missing");
  assert(Boolean(response.headers.get("permissions-policy")), "Permissions-Policy is missing");
}

function assertRevalidation(response, resource) {
  const cacheControl = response.headers.get("cache-control") || "";
  assert(cacheControl.includes("no-cache") && cacheControl.includes("must-revalidate"),
    `${resource} must revalidate its cache`);
  assert(!cacheControl.includes("immutable"), `${resource} must not be immutable`);
}

function moduleBundleUrl(html, base) {
  const scriptMatch = html.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i) ||
    html.match(/<script[^>]+src=["']([^"']+)["'][^>]+type=["']module["']/i);
  assert(scriptMatch, "portal HTML has no module bundle");
  return new URL(scriptMatch[1], base);
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

  assertBrowserSecurityHeaders(response);
});

await runCheck("HTML revalidation and embedded early boot CSP integrity", async () => {
  for (const path of ["/", "/index.html", "/terms?delivery-check=1"]) {
    const { response, text } = await request(new URL(path, portalUrl));
    assert(response.headers.get("content-type")?.includes("text/html"), `${path} is not HTML`);
    assertRevalidation(response, path);
    assertBrowserSecurityHeaders(response);
    const bootTag = /<script\b([^>]*\bid=["']portal-boot["'][^>]*)>([\s\S]*?)<\/script>/i.exec(text);
    assert(bootTag, `${path} is missing its embedded early boot script`);
    assert(!/\b(async|defer|src)\b|\btype=["']module["']/i.test(bootTag[1]), "early boot must execute before modules without a separate request");
    assert(bootTag[2].includes("globalThis"), "early boot is missing the compatibility safeguard");
    const digest = createHash("sha256").update(bootTag[2], "utf8").digest("base64");
    const csp = response.headers.get("content-security-policy") || "";
    const scriptDirective = csp.split(";").find((part) => part.trim().startsWith("script-src ")) || "";
    assert(scriptDirective.includes(`'sha256-${digest}'`), "early boot hash does not match the delivered CSP");
    assert(!scriptDirective.includes("'unsafe-inline'"), "CSP must not allow arbitrary inline scripts");
    const moduleStart = text.search(/<script\b[^>]*\btype=["']module["']/i);
    assert(moduleStart > bootTag.index, "early boot must precede the application module");
  }
});

await runCheck("hashed assets and missing asset responses", async () => {
  const { text: html } = await request(new URL("/", portalUrl));
  const bundleUrl = moduleBundleUrl(html, portalUrl);
  assert(/\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(bundleUrl.pathname), "module bundle is not versioned by hash");
  const { response } = await request(bundleUrl, { expectedStatus: 200 });
  assert(/(?:javascript|ecmascript)/.test(response.headers.get("content-type") || ""), "application bundle is not JavaScript");
  const cacheControl = response.headers.get("cache-control") || "";
  assert(cacheControl.includes("immutable") && cacheControl.includes("max-age=31536000"), "hashed bundle must have immutable long caching");
  assertBrowserSecurityHeaders(response);
  const missingUrl = new URL(`/assets/production-check-missing-${expectedSha}.js`, portalUrl);
  const missing = await request(missingUrl, { expectedStatus: 404 });
  const missingCache = missing.response.headers.get("cache-control") || "";
  assert(missingCache.includes("no-store") && !missingCache.includes("immutable"), "missing bundle must not be cached");
  assert(!/<div id=["']root["']/.test(missing.text), "missing bundle incorrectly contains the SPA document");
  assertBrowserSecurityHeaders(missing.response);
});

await runCheck("deployed phone and CPF bundle contract", async () => {
  const { text: html } = await request(new URL("/", portalUrl));
  const bundleUrl = moduleBundleUrl(html, portalUrl);
  const { text: bundle } = await request(bundleUrl);
  assert(bundle.includes("mb_auth_attempt_id"), "deployed bundle is missing the server-authoritative attempt marker");
  assert(bundle.includes("/identify"), "deployed bundle is missing the phone and CPF endpoint");
  assert(bundle.includes("session_token_hash"), "deployed bundle is missing the client-side session challenge exchange");
  assert(!bundle.includes("google_oauth_started"), "deployed bundle still contains Google OAuth telemetry");
  assert(!bundle.includes("/oauth/callback"), "deployed bundle still contains the OAuth callback");
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
