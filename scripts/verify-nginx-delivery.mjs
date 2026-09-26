// Runs the exact Dockerfile printf output in a local Nginx binary. No external
// API or client authorization is used. Set NGINX_BINARY and, if needed, SH_BINARY.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.env.NGINX_BINARY;
assert(binary, "Set NGINX_BINARY to an existing Nginx executable (no installation is performed)");
const shell = process.env.SH_BINARY || (process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh");
const directory = await mkdtemp(join(tmpdir(), "portal-nginx-delivery-"));
const prefix = directory.replaceAll("\\", "/") + "/";
const nginxHome = dirname(resolve(binary));
const mimeTypes = process.env.NGINX_MIME_TYPES || join(nginxHome, "conf", "mime.types");
const source = await readFile(join(root, "Dockerfile"), "utf8");
const command = source.match(/RUN (printf '[\s\S]*?') > \/etc\/nginx\/conf\.d\/default\.conf/);
assert(command, "Dockerfile must contain the Nginx printf configuration");
const emitted = execFileSync(shell, ["-c", command[1].replace(/\\\r?\n/g, "")], { encoding: "utf8" });
await writeFile(join(directory, "docker-emitted.conf"), emitted);
for (const folder of ["html/assets", "logs", "temp"]) await mkdir(join(directory, folder), { recursive: true });
const bootSource = 'if (typeof window.globalThis === "undefined") window.globalThis = window;';
const bootDigest = createHash("sha256").update(bootSource).digest("base64");
await writeFile(join(directory, "html/index.html"), `<!doctype html><script id="portal-boot">${bootSource}</script><div id="root">synthetic portal</div>`);
await writeFile(join(directory, "html/portal-boot.sha256"), bootDigest);
await writeFile(join(directory, "html/assets/index-AbCd1234.js"), "window.syntheticBundle = true;");
await writeFile(join(directory, "html/assets/unversioned.js"), "window.unversioned = true;");
await writeFile(join(directory, "html/build-info.json"), '{"sha":"synthetic"}');
const bakeCommand = source.match(/RUN (boot_csp_hash=[\s\S]*?)\r?\n\r?\n# Validate Nginx config/);
assert(bakeCommand, "Dockerfile must bake the validated early boot CSP hash");
const bake = bakeCommand[1].replace(/\\\r?\n/g, "")
  .replace("/usr/share/nginx/html/portal-boot.sha256", `"${prefix}html/portal-boot.sha256"`)
  .replace("/etc/nginx/conf.d/default.conf", `"${prefix}docker-emitted.conf"`);
execFileSync(shell, ["-c", bake], { encoding: "utf8" });
const baked = await readFile(join(directory, "docker-emitted.conf"), "utf8");
assert(baked.includes(`'sha256-${bootDigest}'`));
assert(!baked.includes("__PORTAL_BOOT_CSP__"));
for (const invalid of ["invalid", "x".repeat(44), `${bootDigest}\nnot-a-hash`]) {
  await writeFile(join(directory, "html/portal-boot.sha256"), invalid);
  assert.throws(() => execFileSync(shell, ["-c", bake], { stdio: "pipe" }), "invalid CSP digest must reject the Docker build");
}
await writeFile(join(directory, "html/portal-boot.sha256"), bootDigest);

const upstream = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ url: req.url, method: req.method }));
});
await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
const upstreamPort = upstream.address().port;
const reservation = createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
// Only platform paths, loopback listener, and the remote API origin are replaced.
// Locations, cache maps, headers, redirects, query handling, and readiness stay exact.
const config = baked
  .replace("listen 80;", `listen 127.0.0.1:${port};`)
  .replace("root /usr/share/nginx/html;", `root "${prefix}html";`)
  .replace("https://fqamejlyytrhovawgtwg.supabase.co/functions/v1/captive-portal/;", `http://127.0.0.1:${upstreamPort}/functions/v1/captive-portal/;`);
await writeFile(join(directory, "nginx.conf"), `worker_processes 1;\nerror_log logs/error.log;\npid logs/nginx.pid;\nevents { worker_connections 128; }\nhttp {\ninclude "${mimeTypes.replaceAll("\\", "/")}";\n${config}\n}\n`);
const args = ["-p", prefix, "-c", "nginx.conf"];
const options = { cwd: directory, windowsHide: true };
const results = [];
let started = false;

async function get(path, extra = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual", signal: AbortSignal.timeout(3000), ...extra });
}
function secure(response) {
  for (const name of ["strict-transport-security", "content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy"]) {
    assert(response.headers.get(name), `${name} missing on ${response.url} (${response.status})`);
  }
  assert(response.headers.get("content-security-policy").includes("script-src 'self'"));
  const scripts = response.headers.get("content-security-policy").split(";").find((part) => part.trim().startsWith("script-src "));
  assert(scripts.includes(`'sha256-${bootDigest}'`));
  assert(!scripts.includes("'unsafe-inline'"));
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}
async function check(name, fn) {
  await fn();
  results.push(name);
  console.log(`OK: ${name}`);
}

try {
  console.log(execFileSync(binary, ["-v"], { ...options, encoding: "utf8", stdio: "pipe" }).trim());
  execFileSync(binary, [...args, "-t"], { ...options, stdio: "pipe" });
  console.log("OK: Docker-emitted configuration passes nginx -t");
  const daemon = spawn(binary, args, { ...options, stdio: "ignore" });
  daemon.unref();
  started = true;
  let listening = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { listening = (await get("/health")).status === 200; } catch { /* Starting. */ }
    if (listening) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert(listening, "local Nginx did not start");
  await check("HTML, index, and SPA fallback revalidate and retain security headers", async () => {
    for (const path of ["/", "/index.html?store=povao", "/terms?delivery-check=1"]) {
      const response = await get(path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/html/);
      assert.equal(response.headers.get("cache-control"), "no-cache, max-age=0, must-revalidate");
      assert.match(await response.text(), /synthetic portal/);
      secure(response);
    }
  });
  await check("successful hashed JavaScript is immutable, including 304", async () => {
    const response = await get("/assets/index-AbCd1234.js");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    secure(response);
    const conditional = await get("/assets/index-AbCd1234.js", { headers: { "If-None-Match": response.headers.get("etag") } });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.headers.get("cache-control"), "public, max-age=31536000, immutable");
    secure(conditional);
  });
  await check("missing hashes and unversioned assets are never cached", async () => {
    for (const path of ["/assets/missing-AbCd1234.js", "/assets/missing.js"]) {
      const response = await get(path);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.doesNotMatch(await response.text(), /synthetic portal/);
      secure(response);
    }
    const response = await get("/assets/unversioned.js");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    secure(response);
  });
  await check("partial hashed response does not acquire immutable caching", async () => {
    const response = await get("/assets/index-AbCd1234.js", { headers: { Range: "bytes=0-3" } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("cache-control"), "no-store");
    secure(response);
  });
  await check("legacy guest redirect preserves every query parameter", async () => {
    const response = await get("/guest/s/default/?id=synthetic&ap=synthetic&url=http%3A%2F%2Fexample.test%2F%3Fx%3D1");
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://minasbrasilwifi.com.br/?id=synthetic&ap=synthetic&url=http%3A%2F%2Fexample.test%2F%3Fx%3D1");
    secure(response);
  });
  await check("Android and Apple captive probes keep their redirects", async () => {
    for (const path of ["/generate_204", "/gen_204", "/hotspot-detect.html"]) {
      const response = await get(path);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "https://minasbrasilwifi.com.br/");
      secure(response);
    }
  });
  await check("API proxy preserves the backend path and query", async () => {
    const response = await get("/api/captive-portal/?route=%2Fbootstrap&store=povao");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { url: "/functions/v1/captive-portal/?route=%2Fbootstrap&store=povao", method: "GET" });
    secure(response);
  });
  await check("build metadata retains no-store and restrictive CSP", async () => {
    const response = await get("/build-info.json");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });
  await check("readiness requires the embedded boot hash, without a separate boot request", async () => {
    const ready = await get("/ready");
    assert.equal(ready.status, 200);
    await rename(join(directory, "html/portal-boot.sha256"), join(directory, "html/portal-boot.sha256.saved"));
    const response = await get("/ready");
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "missing-portal-boot-hash");
    secure(response);
  });
  console.log(`NGINX DELIVERY VERIFIED: ${results.length} checks; configuration: ${directory}`);
} finally {
  if (started) execFileSync(binary, [...args, "-s", "quit"], { ...options, stdio: "pipe" });
  await new Promise((done) => upstream.close(done));
}
