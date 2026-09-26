/**
 * Fault-injection checks against the actual production build, served only on
 * loopback. This server has no upstream. No real authorization is performed.
 *
 * npm run build
 * PORTAL_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/verify-portal-startup.mjs
 * Optional: PORTAL_STARTUP_DIST, PORTAL_STARTUP_REPORT, PORTAL_STARTUP_SCENARIOS.
 * Set PORTAL_STARTUP_PREVIOUS_HTML to a saved prior production document to
 * verify that its referenced assets still work after deploying this build.
 * Chromium must already be installed for the selected Playwright package.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(process.env.PORTAL_STARTUP_DIST || path.join(repository, "dist"));
const reportPath = path.resolve(process.env.PORTAL_STARTUP_REPORT || path.join(repository, "tmp", "portal-startup", "results.json"));
const playwrightModule = process.env.PORTAL_PLAYWRIGHT_MODULE;
const { chromium } = await import(playwrightModule
  ? (/^[a-z]+:\/\//i.test(playwrightModule) ? playwrightModule : pathToFileURL(path.resolve(playwrightModule)).href)
  : "playwright");
// Freeze the build before opening the browser: another build may replace dist
// while this matrix runs. Every scenario must verify the same byte snapshot.
const buildFiles = new Map();
async function snapshotDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await snapshotDirectory(fullPath);
    else if (entry.isFile()) buildFiles.set("/" + path.relative(dist, fullPath).split(path.sep).join("/"), await readFile(fullPath));
  }
}
await snapshotDirectory(dist);
const html = buildFiles.get("/index.html")?.toString("utf8");
assert(html, "Build has no index.html");
const dockerfile = await readFile(path.join(repository, "Dockerfile"), "utf8");
// Read the policy used by the container, including its shell-escaped quotes.
let csp = dockerfile.match(/add_header Content-Security-Policy "(default-src .*?)" always/)?.[1].replaceAll("'\\''", "'");
const bootScript = html.match(/<script\b(?=[^>]*\bid="portal-boot")[^>]*>([\s\S]*?)<\/script>/)?.[1];
assert(bootScript, "Build does not contain the inline startup guard");
const bootHash = createHash("sha256").update(bootScript).digest("base64");
const recordedHash = buildFiles.get("/portal-boot.sha256")?.toString("utf8").trim();
assert.equal(recordedHash, bootHash, "Startup guard hash artifact does not match its exact HTML bytes");
csp = csp?.replaceAll("__PORTAL_BOOT_CSP__", `'sha256-${bootHash}'`);
assert(csp?.includes("script-src 'self'"), "Production CSP was not found in Dockerfile");
const mainScript = html.match(/<script\b(?=[^>]*\btype="module")(?=[^>]*\bsrc="([^"]+)")[^>]*>/)?.[1];
const mainStylesheet = html.match(/<link\b(?=[^>]*\brel="stylesheet")(?=[^>]*\bhref="([^"]+)")[^>]*>/)?.[1];
assert(mainScript, "Build has no module script");
assert(mainStylesheet, "Build has no stylesheet");
assert(!html.includes('src="/portal-boot.js"'), "Startup guard must not depend on a separate network request");
const mainBytes = buildFiles.get(mainScript);
assert(mainBytes, "Module referenced by index.html is absent from the build");
const report = {
  checkedAt: new Date().toISOString(),
  scope: "Actual build in current Chromium with Android user agent, touch and mobile viewport. API absence and delivery faults are simulated; this is not a real Android/WebView or captive-network test.",
  isolation: "Loopback-only fixture without upstream; browser denies all other origins. No authorization endpoint is allowed.",
  dist,
  csp,
  mainScript,
  mainSha256: createHash("sha256").update(mainBytes).digest("hex"),
  bootSha256Base64: bootHash,
  scenarios: [],
};
const previousHtml = process.env.PORTAL_STARTUP_PREVIOUS_HTML
  ? await readFile(path.resolve(process.env.PORTAL_STARTUP_PREVIOUS_HTML), "utf8") : undefined;
if (previousHtml) {
  const previousScript = previousHtml.match(/<script\b(?=[^>]*\btype="module")(?=[^>]*\bsrc="([^"]+)")[^>]*>/)?.[1];
  assert(previousScript && buildFiles.has(previousScript), "The saved prior document references a module not retained in this build");
  report.previousRelease = { mainScript: previousScript,
    mainSha256: createHash("sha256").update(buildFiles.get(previousScript)).digest("hex"),
    documentSha256: createHash("sha256").update(previousHtml).digest("hex") };
}

const scenarios = [
  { name: "baseline" },
  { name: "no-globalThis", setup: "no-globalThis" },
  { name: "storage-denied", setup: "storage-denied" },
  { name: "older-runtime", setup: "older-runtime" },
  { name: "bootstrap-503", api: "503" },
  { name: "bootstrap-timeout", api: "timeout" },
  { name: "session-lookup-stalled", setup: "session-stalled", minimumMs: 2800 },
  { name: "module-404", scriptFault: "404", recovery: true },
  { name: "module-html-response", scriptFault: "html", recovery: true },
  { name: "module-never-arrives", scriptFault: "hold", recovery: true, timeout: true },
  { name: "module-timeout-retry", scriptFault: "hold", recovery: true, timeout: true, retry: true },
  { name: "stylesheet-404", cssFault: "404", recovery: true, sticky: true },
  { name: "stylesheet-html-response", cssFault: "html", recovery: true, sticky: true },
  { name: "stylesheet-timeout-retry", cssFault: "hold", recovery: true, timeout: true, retry: true },
  { name: "module-404-with-stalled-css-retry", scriptFault: "404", cssFault: "hold", recovery: true, retry: true, expectedFailures: ["script", "stylesheet"] },
  { name: "late-module-recovers", scriptFault: "hold", recovery: true, late: true },
  { name: "module-unsupported", setup: "no-module", removeModule: true, recovery: true },
  { name: "unsupported-with-stalled-css", setup: "no-module", removeModule: true, cssFault: "hold", recovery: true, expectedFailures: ["unsupported"] },
  { name: "react-render-failure", setup: "render-failure", recovery: true },
  { name: "manual-retry-preserves-visit", scriptFault: "404", recovery: true, retry: true },
  { name: "manual-retry-resumes-attempt", scriptFault: "404", recovery: true, retry: true, resume: true },
  { name: "javascript-disabled", javaScriptEnabled: false, noScript: true },
  ...(previousHtml ? [{ name: "previous-release-cached-html", previous: true }] : []),
];
const requested = process.env.PORTAL_STARTUP_SCENARIOS?.split(",").map(value => value.trim()).filter(Boolean);
if (requested) {
  assert(requested.length > 0, "Scenario selection must not be empty");
  assert(requested.every(name => scenarios.some(item => item.name === name)), "Unknown requested scenario");
}

let active;
const sockets = new Set();
const server = createServer(async (req, res) => {
  const run = active;
  try {
    assert(run, "Fixture has no active scenario");
    const url = new URL(req.url, "http://127.0.0.1");
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    if (url.pathname.startsWith("/api/")) {
      const route = url.searchParams.get("route") || url.pathname;
      let body = "";
      for await (const chunk of req) body += chunk.toString();
      run.api.push({ route, method: req.method });
      res.setHeader("Content-Type", "application/json");
      if (["/attempt/init", "/identify", "/authorize-existing"].includes(route)) {
        run.forbiddenAuthorizationCalls.push(route);
        res.writeHead(503).end('{"error":"Authorization is forbidden in the startup fixture"}');
      } else if (route === "/bootstrap") {
        if (run.scenario.api === "timeout") { run.pending.push(res); return; }
        if (run.scenario.api === "503") { res.writeHead(503).end('{"error":"Synthetic bootstrap unavailable"}'); return; }
        res.end(JSON.stringify({ store: { slug: "povao", name: "Unidade sintética" }, consent: null }));
      } else if (route === "/attempt/status" && run.scenario.resume) {
        const received = JSON.parse(body);
        assert.equal(received.attempt_id, "synthetic-attempt-startup");
        assert.equal(received.token, "synthetic-token-no-authority");
        res.end(JSON.stringify({ authorized: false, status: "verifying", retry_after_ms: 30000,
          server_now: new Date().toISOString(), deadline_at: new Date(Date.now() + 120000).toISOString() }));
      } else if (route === "/client-event") {
        res.end('{"ok":true}');
      } else {
        res.writeHead(503).end('{"error":"No upstream configured for this synthetic route"}');
      }
      return;
    }

    const isDocument = url.pathname === "/" || url.pathname === "/index.html";
    if (isDocument) {
      run.documents += 1;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // Only this scenario changes the document, to emulate a browser that
      // cannot execute module scripts. Application JS remains byte-identical.
      const documentHtml = run.scenario.previous ? previousHtml : html;
      const body = run.scenario.removeModule
        ? documentHtml.replace(/<script\b[^>]*\btype="module"[^>]*>[\s\S]*?<\/script>/g, "")
        : documentHtml;
      res.end(body);
      return;
    }
    const scriptFault = url.pathname === mainScript && !run.retryStarted ? run.scenario.scriptFault : undefined;
    const cssFault = url.pathname === mainStylesheet && !run.retryStarted ? run.scenario.cssFault : undefined;
    const fault = scriptFault || cssFault;
    if (fault === "404") { res.writeHead(404, { "Content-Type": "text/plain" }).end("Synthetic missing asset"); return; }
    if (fault === "html") { res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>Synthetic stale fallback</title>"); return; }
    if (fault === "hold") { run.pending.push(res); return; }
    const file = path.resolve(dist, "." + decodeURIComponent(url.pathname));
    assert(file.startsWith(dist + path.sep), "Request escaped the build directory");
    const bytes = buildFiles.get(url.pathname);
    if (!bytes) {
      run.missingAssets.push(url.pathname);
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    const mime = { ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2" }[path.extname(file)] || "application/octet-stream";
    res.setHeader("Content-Type", mime);
    res.end(bytes);
  } catch (error) {
    if (run) run.fixtureErrors.push(String(error));
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Synthetic fixture error");
  }
});
server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const visit = "/?store=povao&id=02%3A00%3A00%3A00%3A00%3A01&ap=02%3A00%3A00%3A00%3A00%3A02&ssid=MINASBRASIL_TEST&t=synthetic&url=https%3A%2F%2Fexample.invalid%2Fpath%3Fx%3D1%26y%3D2#visit-preserved";
const browser = await chromium.launch({ headless: true, args: ["--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
await mkdir(path.dirname(reportPath), { recursive: true });

try {
  for (const scenario of scenarios.filter(item => !requested || requested.includes(item.name))) {
    const run = { scenario, documents: 0, api: [], pending: [], forbiddenAuthorizationCalls: [], externalRequests: [], fixtureErrors: [], pageErrors: [], consoleErrors: [], missingAssets: [], retryStarted: false };
    active = run;
    const outcome = { name: scenario.name, passed: false, observations: {} };
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      serviceWorkers: "block", javaScriptEnabled: scenario.javaScriptEnabled !== false,
      userAgent: "Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36" });
    context.setDefaultTimeout(6500);
    context.setDefaultNavigationTimeout(6500);
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      run.externalRequests.push(url.origin + url.pathname);
      return route.abort("blockedbyclient");
    });
    await context.addInitScript(({ setup, resume }) => {
      window.__startupTestCspViolations = [];
      window.addEventListener("securitypolicyviolation", event => window.__startupTestCspViolations.push(event.violatedDirective));
      if (setup === "no-globalThis") delete window.globalThis;
      if (setup === "storage-denied") {
        for (const key of ["sessionStorage", "localStorage"]) Object.defineProperty(window, key, { get() { throw new Error("Synthetic storage denied"); } });
      }
      if (setup === "older-runtime") {
        delete window.AbortController;
        delete window.BroadcastChannel;
        delete Object.fromEntries;
        Object.defineProperty(navigator, "locks", { value: undefined });
      }
      if (setup === "session-stalled") Object.defineProperty(navigator, "locks", { value: { request() { return new Promise(() => {}); } } });
      if (setup === "no-module") delete HTMLScriptElement.prototype.noModule;
      if (setup === "render-failure") {
        const create = document.createElement.bind(document);
        document.createElement = function (tag, ...args) {
          if (String(tag).toLowerCase() === "input") throw new Error("Synthetic React DOM creation failed");
          return create(tag, ...args);
        };
      }
      if (resume && !sessionStorage.getItem("synthetic-attempt-seeded")) {
        sessionStorage.setItem("synthetic-attempt-seeded", "true");
        sessionStorage.setItem("mb_auth_attempt_v2", JSON.stringify({ version: 2, attempt_id: "synthetic-attempt-startup",
          token: "synthetic-token-no-authority", context: JSON.stringify(["020000000001", "020000000002", "MINASBRASIL_TEST", "povao", "", "synthetic"]),
          expires_at: new Date(Date.now() + 600000).toISOString(), submitted: true, clock_origin: performance.timeOrigin,
          expires_monotonic_ms: performance.now() + 600000 }));
      }
    }, { setup: scenario.setup, resume: !!scenario.resume });
    const page = await context.newPage();
    page.on("pageerror", error => run.pageErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") run.consoleErrors.push(message.text()); });
    const started = Date.now();
    try {
      await page.goto(origin + visit, { waitUntil: "commit" });
      if (scenario.noScript) {
        await page.locator("noscript").waitFor({ state: "visible", timeout: 5000 });
        assert.match(await page.locator("noscript").innerText(), /JavaScript/i);
      } else if (scenario.recovery) {
        await page.locator("#portal-recovery").waitFor({ state: "visible", timeout: 14000 });
        outcome.observations.recoveryMs = Date.now() - started;
        const expectedFailure = scenario.cssFault ? "stylesheet" : scenario.timeout || scenario.late ? "timeout"
          : scenario.removeModule ? "unsupported" : scenario.setup === "render-failure" ? "render" : "script";
        outcome.observations.failure = await page.locator("#portal-recovery").getAttribute("data-failure");
        assert((scenario.expectedFailures || [expectedFailure]).includes(outcome.observations.failure), "Recovery was triggered by a different failure than the injected fault");
        assert.equal(await page.getByLabel("CPF", { exact: true }).isVisible(), false, "A broken form must not remain visible under the recovery message");
        assert.equal(run.documents, 1, "Recovery must not reload automatically");
        if (scenario.timeout || scenario.late) assert(outcome.observations.recoveryMs >= 9000, "Watchdog recovered before its configured grace period");
        if (scenario.sticky) {
          await page.waitForTimeout(1000);
          assert.equal(await page.locator("#portal-recovery").isVisible(), true, "React ready incorrectly cleared a stylesheet failure");
        }
        if (scenario.removeModule) assert.equal(await page.locator("#portal-retry").isVisible(), false, "Unsupported module browsers should receive guidance without a futile retry");
        // DOM visibility is insufficient while a stylesheet blocks painting.
        // A screenshot forces the renderer to produce a frame of the fallback.
        if (scenario.removeModule) {
          const screenshot = path.join(path.dirname(reportPath), `${scenario.name}.png`);
          await page.screenshot({ path: screenshot, timeout: scenario.cssFault === "hold" ? 14000 : 3000 });
          outcome.screenshot = screenshot;
        }
        if (scenario.late) {
          const held = run.pending.splice(0);
          assert(held.length > 0, "Module was not held by the fixture");
          for (const response of held) response.writeHead(200, { "Content-Type": "text/javascript" }).end(mainBytes);
          await page.getByLabel("CPF", { exact: true }).waitFor({ timeout: 5000 });
          assert.equal(await page.locator("#portal-recovery").isVisible(), false, "Late successful startup did not clear timeout recovery");
          assert.equal(run.documents, 1, "Late startup reloaded the page");
        }
        if (scenario.retry) {
          const before = page.url();
          run.retryStarted = true;
          await page.locator("#portal-retry").click();
          await page.waitForLoadState("domcontentloaded");
          if (scenario.resume) {
            await page.getByText("Confirmando seu acesso ao Wi-Fi...", { exact: true }).waitFor({ timeout: 5000 });
            const record = await page.evaluate(() => JSON.parse(sessionStorage.getItem("mb_auth_attempt_v2")));
            assert.equal(record.attempt_id, "synthetic-attempt-startup");
            assert.equal(record.token, "synthetic-token-no-authority");
            assert(run.api.some(request => request.route === "/attempt/status"), "Existing attempt was not resumed");
          } else await page.getByLabel("CPF", { exact: true }).waitFor({ timeout: 5000 });
          assert.equal(page.url(), before, "Manual retry changed captive parameters or fragment");
          assert.equal(run.documents, 2, "One click must perform exactly one reload");
          assert.equal(await page.locator("#portal-recovery").isVisible(), false);
        }
      } else {
        await page.getByLabel("CPF", { exact: true }).waitFor({ timeout: 6500 });
        outcome.observations.formMs = Date.now() - started;
        assert.equal(await page.locator("#portal-recovery").isVisible(), false);
        assert.equal(run.documents, 1, "Successful startup reloaded the page");
        if (scenario.minimumMs) assert(outcome.observations.formMs >= scenario.minimumMs, "Session lookup did not actually stall");
        if (scenario.setup === "no-globalThis") assert.equal(await page.evaluate(() => window.globalThis === window), true);
        assert.deepEqual(run.pageErrors, [], "Unexpected JavaScript errors");
      }
      if (!scenario.noScript) assert.deepEqual(await page.evaluate(() => window.__startupTestCspViolations), [], "Application violated production CSP");
      assert.deepEqual(run.fixtureErrors, [], "Fixture failed");
      assert.deepEqual(run.forbiddenAuthorizationCalls, [], "Startup or reload attempted a new authorization");
      assert.deepEqual(run.externalRequests, [], "Application attempted an external request during isolated startup");
      assert.deepEqual(run.missingAssets, [], "Build referenced a missing file outside the injected fault");
      outcome.passed = true;
      if (["baseline", "no-globalThis", "module-404", "stylesheet-404"].includes(scenario.name)) {
        const screenshot = path.join(path.dirname(reportPath), `${scenario.name}.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        outcome.screenshot = screenshot;
      }
      console.log(`PASS ${scenario.name}`);
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
      try {
        outcome.pageState = await page.evaluate(() => ({ readyState: document.readyState,
          stylesheets: Array.from(document.querySelectorAll('link[rel="stylesheet"]'), link => ({ href: link.getAttribute("href"), sheetLoaded: !!link.sheet, disabled: link.disabled })),
          recovery: document.getElementById("portal-recovery")?.getAttribute("data-failure") }));
      } catch { /* The renderer itself may be unavailable. */ }
      const screenshot = path.join(path.dirname(reportPath), `${scenario.name}-failure.png`);
      try { await page.screenshot({ path: screenshot, timeout: 3000 }); outcome.screenshot = screenshot; } catch { /* Capture is best effort. */ }
      console.error(`FAIL ${scenario.name}: ${outcome.error}`);
    } finally {
      outcome.elapsedMs = Date.now() - started;
      outcome.observations.documents = run.documents;
      outcome.observations.api = run.api;
      outcome.pageErrors = run.pageErrors;
      outcome.consoleErrors = run.consoleErrors;
      outcome.externalRequests = run.externalRequests;
      outcome.fixtureErrors = run.fixtureErrors;
      outcome.missingAssets = run.missingAssets;
      report.scenarios.push(outcome);
      await context.close();
      for (const response of run.pending.splice(0)) response.destroy();
      await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    }
  }
} finally {
  await browser.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
const failed = report.scenarios.filter(result => !result.passed);
console.log(`${report.scenarios.length - failed.length}/${report.scenarios.length} startup scenarios passed. Report: ${reportPath}`);
if (failed.length) process.exitCode = 1;
