/** Actual production bundle, loopback-only API fixtures. No live authorization.
 * Covers phone integrity, persistent Retry-After and eventual status recovery.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.PORTAL_RECOVERY_REPORT_DIR || path.join(repository, 'tmp/portal-recovery'));
await mkdir(output, { recursive: true });
const dist = path.resolve(process.env.PORTAL_RECOVERY_DIST || path.join(repository, 'dist'));
const { chromium } = await import(process.env.PORTAL_PLAYWRIGHT_MODULE ? pathToFileURL(path.resolve(process.env.PORTAL_PLAYWRIGHT_MODULE)).href : 'playwright');
const files = new Map();
async function snapshot(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await snapshot(file);
    else files.set('/' + path.relative(dist, file).split(path.sep).join('/'), await readFile(file));
  }
}
await snapshot(dist);
const html = files.get('/index.html').toString('utf8');
const modulePath = html.match(/<script\b(?=[^>]*\btype="module")(?=[^>]*\bsrc="([^"]+)")[^>]*>/)[1];
const boot = html.match(/<script\b(?=[^>]*\bid="portal-boot")[^>]*>([\s\S]*?)<\/script>/)[1];
const bootHash = createHash('sha256').update(boot).digest('base64');
assert.equal(files.get('/portal-boot.sha256').toString('utf8').trim(), bootHash);
const docker = await readFile(path.join(repository, 'Dockerfile'), 'utf8');
const csp = docker.match(/add_header Content-Security-Policy "(default-src .*?)" always/)[1].replaceAll("'\\''", "'").replaceAll('__PORTAL_BOOT_CSP__', `'sha256-${bootHash}'`);
let current;
const sockets = new Set();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname.startsWith('/api/')) {
    const route = url.searchParams.get('route');
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const body = raw ? JSON.parse(raw) : null;
    current.requests.push({ route, at: Date.now() - current.started });
    res.setHeader('Content-Type', 'application/json');
    if (route === '/bootstrap') return res.end(JSON.stringify({ store: { slug: 'povao', name: 'Unidade sintética' }, consent: null }));
    if (route === '/client-event') return res.end('{"ok":true}');
    if (route === '/attempt/init') return res.end(JSON.stringify({ attempt_id: 'synthetic-attempt-no-authority', token: 'synthetic-token-no-authority', server_now: new Date().toISOString(), expires_at: new Date(Date.now() + 600000).toISOString() }));
    if (route === '/identify') {
      current.sentPhone = body.phone;
      return res.end(JSON.stringify({ authorized: false, status: 'verifying', processing: true, retry_after_ms: 30000, server_now: new Date().toISOString() }));
    }
    if (route === '/attempt/status') {
      current.statusCalls += 1;
      if (current.statusCalls === 1) {
        current.rateLimitedAt = Date.now();
        res.setHeader('Retry-After', '30');
        return res.writeHead(429).end(JSON.stringify({ error: 'Aguarde sinteticamente', retry_after_ms: 30000, server_now: new Date().toISOString() }));
      }
      current.statusAfter429Ms.push(Date.now() - current.rateLimitedAt);
      return res.end(JSON.stringify({ authorized: false, status: 'verifying', processing: true, retry_after_ms: 30000, server_now: new Date().toISOString() }));
    }
    current.unexpectedRoutes.push(route);
    return res.writeHead(503).end('{"error":"No upstream exists"}');
  }
  const route = files.has(url.pathname) ? url.pathname : (!path.extname(url.pathname) ? '/index.html' : url.pathname);
  const body = files.get(route);
  if (!body) return res.writeHead(404).end('missing');
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' })[path.extname(route)] || 'application/octet-stream');
  res.end(body);
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const visit = '/?store=povao&id=02:00:00:00:00:01&ap=02:00:00:00:00:11&ssid=TEST&t=1';
const browser = await chromium.launch({ headless: true, args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
const report = { createdAt: new Date().toISOString(), modulePath, moduleSha256: createHash('sha256').update(files.get(modulePath)).digest('hex'), scope: 'Actual frozen build in current Chromium with Android UA/mobile viewport. All API responses are local synthetic fixtures, no upstream exists. Not a physical Android or live Wi-Fi test.', scenarios: [] };
try {
  for (const scenario of [
    { name: 'national-control', phone: '(38) 99999-9999', expectedPhone: '38999999999' },
    { name: 'e164', phone: '5538999999999', expectedPhone: '38999999999' },
    { name: 'national-ddd55', phone: '(55) 99999-9999', expectedPhone: '55999999999' },
    { name: 'oversized-phone', phone: '+55 (38) 99999-99999', invalidPhone: true },
    { name: 'mobile-plus55', phone: '+55 (38) 99999-9999', expectedPhone: '38999999999' },
    { name: 'landline-plus55', phone: '+55 (38) 3222-2222', expectedPhone: '3832222222' },
    { name: 'northern-plus55', phone: '+55 (91) 99999-9999', expectedPhone: '91999999999' },
    { name: 'status429-mounted-control', seed: true },
    { name: 'status429-page-reload', seed: true, reload: true },
    { name: 'status429-privacy-return', seed: true, privacy: true },
  ]) {
    current = { name: scenario.name, started: Date.now(), requests: [], statusCalls: 0, statusAfter429Ms: [], unexpectedRoutes: [], blockedExternal: [], pageErrors: [] };
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', userAgent: 'Mozilla/5.0 (Linux; Android 11; synthetic) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36' });
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== origin) { current.blockedExternal.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    if (scenario.seed) await context.addInitScript(() => {
      if (!sessionStorage.getItem('mb_auth_attempt_v2')) sessionStorage.setItem('mb_auth_attempt_v2', JSON.stringify({ version: 2, attempt_id: 'synthetic-attempt-no-authority', token: 'synthetic-token-no-authority', context: JSON.stringify(['020000000001', '020000000011', 'TEST', 'povao', '', '1']), submitted: true, expires_at: new Date(Date.now() + 600000).toISOString(), clock_origin: performance.timeOrigin, expires_monotonic_ms: performance.now() + 600000 }));
    });
    const page = await context.newPage();
    page.on('pageerror', error => current.pageErrors.push(error.message));
    try {
      await page.goto(origin + visit, { waitUntil: 'domcontentloaded' });
      if (scenario.phone) {
        await page.getByLabel('Telefone', { exact: true }).fill(scenario.phone);
        current.displayedPhone = await page.getByLabel('Telefone', { exact: true }).inputValue();
        await page.getByLabel('CPF', { exact: true }).fill('52998224725');
        await page.getByRole('button', { name: 'Liberar Wi-Fi', exact: true }).click();
        await page.waitForTimeout(300);
        current.alert = await page.getByRole('alert').count() ? await page.getByRole('alert').textContent() : null;
        current.expectationMet = scenario.invalidPhone
          ? !!current.alert && !current.requests.some(request => ['/attempt/init', '/identify'].includes(request.route))
          : current.sentPhone === scenario.expectedPhone
            && current.requests.filter(request => request.route === '/attempt/init').length === 1
            && current.requests.filter(request => request.route === '/identify').length === 1;
        current.expectedPhone = scenario.expectedPhone;
      } else {
        await page.getByRole('button', { name: 'Aguarde 30 s', exact: true }).waitFor();
        if (scenario.reload) await page.reload({ waitUntil: 'domcontentloaded' });
        if (scenario.privacy) {
          await page.getByRole('link', { name: 'Política de Privacidade', exact: true }).click();
          await page.getByRole('heading', { name: 'Política de Privacidade', exact: true }).waitFor();
          await page.getByRole('link', { name: 'Voltar ao portal', exact: true }).click();
          await page.getByText('Confirmando seu acesso ao Wi-Fi...', { exact: true }).waitFor();
        }
        await page.waitForTimeout(1200);
        current.expectationMet = current.statusCalls === 1;
        if (scenario.reload) {
          await page.waitForResponse(response => response.url().includes('route=%2Fattempt%2Fstatus') && response.status() === 200, { timeout: 35000 });
          current.expectationMet = current.expectationMet && current.statusCalls === 2 && current.statusAfter429Ms[0] >= 30000;
        }
        current.sameCapabilityRetained = await page.evaluate(() => {
          const attempt = JSON.parse(sessionStorage.getItem('mb_auth_attempt_v2'));
          return attempt.attempt_id === 'synthetic-attempt-no-authority' && attempt.token === 'synthetic-token-no-authority';
        });
        current.expectationMet = current.expectationMet && current.sameCapabilityRetained
          && !current.requests.some(request => ['/attempt/init', '/identify'].includes(request.route));
      }
      current.screenshot = path.join(output, `${scenario.name}.png`);
      await page.screenshot({ path: current.screenshot });
    } catch (error) { current.fixtureError = String(error); }
    report.scenarios.push(current);
    await context.close();
  }
} finally {
  await browser.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
await writeFile(path.join(output, 'browser-results.json'), JSON.stringify(report, null, 2));
for (const run of report.scenarios) console.log(`${run.expectationMet && !run.fixtureError ? 'PASS' : 'FAIL'} ${run.name}`);
console.log(`Report: ${path.join(output, 'browser-results.json')}`);
if (report.scenarios.some(run => !run.expectationMet || run.fixtureError || run.unexpectedRoutes.length || run.blockedExternal.length || run.pageErrors.length)) process.exitCode = 1;
