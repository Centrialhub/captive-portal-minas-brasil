import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { webcrypto, randomUUID, createHash } from 'node:crypto';
import vm from 'node:vm';
import pg from 'pg';

// The actual ingress handlers, capability validation and Postgres limiter run
// here. Only store discovery, identity profiles and durable authorization are
// fixtures. No external fetch or controller authorization can be performed.
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const artifacts = path.join(root, 'tmp/post-audit-fixes-20260926/admission');
await mkdir(artifacts, { recursive: true });
const ts = createRequire(path.join(root, 'package.json'))('typescript');
const bin = path.join(dir, 'node_modules/@embedded-postgres/windows-x64/native/bin');
if (process.platform !== 'win32') throw new Error('This native harness requires Windows x64; see tests/database/README.md.');
const source = await readFile(path.join(root, 'supabase/functions/captive-portal/index.ts'), 'utf8');
const tree = ts.createSourceFile('edge.ts', source, ts.ScriptTarget.Latest, true);
const wanted = new Set(['handleIdentity', 'handleAttemptInit', 'getValidatedAuthContext', 'validateAuthAttempt',
  'extractAuthContext', 'checkRateLimitDb', 'rateLimitedResponse', 'getPublicIp', 'sha256Hex', 'normalizeMac', 'isValidUUID']);
const selected = tree.statements.filter(n => ts.isFunctionDeclaration(n) && wanted.has(n.name?.text));
assert.equal(selected.length, wanted.size);
const validators = tree.statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(tree) === 'Validators'));
assert.ok(validators);
const constants = tree.statements.filter(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => ['MAC_REGEX', 'VALID_BR_DDD'].includes(d.name.getText(tree))));
assert.equal(constants.length, 2);
const identity = await readFile(path.join(root, 'supabase/functions/_shared/identity.ts'), 'utf8');
const compiled = ts.transpileModule(constants.map(n => n.getText(tree)).join('\n') + '\n' + validators.getText(tree) + '\n' + selected.map(n => n.getText(tree)).join('\n') + '\n' + identity.replaceAll('export ', ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const oldMigration = await readFile(path.join(root, 'supabase/migrations/20260925164858_durable_captive_auth_operations.sql'), 'utf8');
const limiterSql = oldMigration.match(/CREATE OR REPLACE FUNCTION public\.rate_limit_hit\([\s\S]*?\n\$\$;/)?.[0];
assert.ok(limiterSql);
const data = await mkdtemp(path.join(artifacts, 'pg-'));
const expectedData = await realpath(data);
const options = { host: '127.0.0.1', port: 55459, database: 'postgres', user: 'postgres', connectionTimeoutMillis: 1000 };
let server, serverError, serverExit, client, logs = '';
const connections = [];
const samePath = (a, b) => path.resolve(a).replaceAll('\\', '/').toLowerCase() === path.resolve(b).replaceAll('\\', '/').toLowerCase();
const run = (exe, args) => {
  const r = spawnSync(path.join(bin, exe), args, { windowsHide: true, encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || `${exe}:${r.status}`);
};
function alive() {
  if (!server?.pid || serverError || serverExit || server.exitCode !== null || server.signalCode !== null) return false;
  try { process.kill(server.pid, 0); return true; } catch { return false; }
}
async function ownedPid() {
  const lines = (await readFile(path.join(data, 'postmaster.pid'), 'utf8')).split(/\r?\n/);
  return Number(lines[0]) === server.pid && samePath(await realpath(lines[1]), expectedData);
}
async function connect() {
  const c = new pg.Client(options);
  try {
    await c.connect();
    const actual = (await c.query('SHOW data_directory')).rows[0].data_directory;
    if (!samePath(await realpath(actual), expectedData) || !alive() || !await ownedPid()) throw new Error('HARNESS_CLUSTER_MISMATCH');
    connections.push(c); return c;
  } catch (e) { await c.end().catch(() => {}); throw e; }
}
const results = { started_at: new Date().toISOString(), passed: [], failed: [], observations: [] };
async function test(name, fn) {
  await client.query('TRUNCATE public.rate_limits, public.captive_identity_admissions, public.captive_auth_attempts CASCADE');
  try { await fn(); results.passed.push(name); console.log('PASS ' + name); }
  catch (e) { if (e.code !== 'ERR_ASSERTION') throw e; results.failed.push({ name, message: e.message, actual: e.actual, expected: e.expected }); console.error('FAIL ' + name + ': ' + e.message); }
}
const hash = x => createHash('sha256').update(x).digest('hex');
function cpf(n) {
  let base = String(100000000 + n);
  for (const weight of [10, 11]) {
    let sum = 0;
    for (let i = 0; i < base.length; i++) sum += Number(base[i]) * (weight - i);
    const dv = (sum * 10) % 11;
    base += dv === 10 ? '0' : String(dv);
  }
  return base;
}
let serial = 0;
const store = randomUUID();
function harness() {
  const users = new Map(), profiles = new Map(), admitted = [], queriedRates = [], alreadyAdmitted = new Set();
  let rpcFailure = false, stopBeforeJoin = false, loseNextReply = false;
  const db = {
    async rpc(name, args) {
      if (rpcFailure && name === 'admit_captive_identity') return { data: null, error: { code: 'FIXTURE_UNAVAILABLE' } };
      if (name === 'rate_limit_hit') {
        queriedRates.push(args);
        const r = await client.query('select rate_limit_hit($1,$2,$3,$4) value', [args.p_key, args.p_window_seconds, args.p_max_hits, args.p_block_seconds]);
        return { data: r.rows[0].value, error: null };
      }
      if (name === 'admit_captive_identity') {
        queriedRates.push(args);
        const r = await client.query('select admit_captive_identity($1,$2,$3,$4) value', [args.p_attempt_id, args.p_resume_token, args.p_identity_hash, args.p_origin_hash]);
        if (loseNextReply) { loseNextReply = false; return { data: null, error: { code: 'FIXTURE_RESPONSE_LOST_AFTER_COMMIT' } }; }
        return { data: r.rows[0].value, error: null };
      }
      if (name === 'resolve_portal_identity') {
        if (stopBeforeJoin) return { data: null, error: { code: 'FIXTURE_LOST_DEPENDENCY' } };
        return { data: [{ resolution_status: 'existing', user_id: users.get(args.p_cpf_digits) }], error: null };
      }
      throw new Error('UNEXPECTED_RPC:' + name);
    },
    from(table) {
      let id, inserted;
      const q = { select: () => q, eq: (key, value) => { if (key === 'id') id = value; return q; }, insert: value => { inserted = value; return q; },
        maybeSingle: async () => ({ data: table === 'profiles' ? profiles.get(id) : table === 'captive_auth_attempts'
          ? (await client.query('select * from captive_auth_attempts where id=$1', [id])).rows[0] : null, error: null }),
        single: async () => {
          assert.equal(table, 'captive_auth_attempts'); assert.ok(inserted);
          const fields = Object.keys(inserted);
          const r = await client.query(`INSERT INTO captive_auth_attempts(${fields.join(',')}) VALUES(${fields.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, Object.values(inserted));
          return { data: r.rows[0], error: null };
        } };
      return q;
    },
  };
  const context = vm.createContext({ Date, URL, Request, Response, TextEncoder, Uint8Array, setTimeout, clearTimeout,
    crypto: webcrypto, VALID_BR_DDD: new Set([38]),
    Logger: { info() {}, warn() {}, error() {} }, logEvent() {},
    fetch() { throw new Error('EXTERNAL_NETWORK_PROHIBITED'); },
    supabaseAdmin: () => db, safeParseJson: r => r.json(), getTraceId: () => 'synthetic',
    sanitizeString: (s, max) => typeof s === 'string' ? s.slice(0, max) : null,
    jsonResponse: (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    errorResponse: (error, status = 400) => new Response(JSON.stringify({ error }), { status }),
    detectStoreFromRequest: async () => ({ store_id: store, store_slug: 'povao', store_name: 'Synthetic', detection_source: 'ap_mapping' }),
    discoverStoreByClientMac: async () => { throw new Error('UNEXPECTED_DISCOVERY'); },
    readOperation: async (_db, attempt) => alreadyAdmitted.has(attempt) ? { operation_id: 'already-committed' } : { disposition: 'awaiting_identity' },
    handleAttemptStatus: async () => new Response(JSON.stringify({ authorized: false, processing: true, status: 'verifying' })),
    getActiveUserBlock: async () => null,
    authorizeAuthenticatedUser: async args => {
      admitted.push(args.attemptId); alreadyAdmitted.add(args.attemptId);
      return { authorized: false, processing: true, status: 'queued', operation_id: randomUUID(), session_id: randomUUID(), store_id: store, store_slug: 'povao' };
    },
  });
  vm.runInContext(compiled, context);
  function person() {
    const seq = ++serial, userId = randomUUID(), cpfDigits = cpf(seq), phone = '389' + String(seq).padStart(8, '0');
    users.set(cpfDigits, userId);
    profiles.set(userId, { id: userId, full_name: 'Synthetic', cpf_digits: cpfDigits, phone_digits: phone, email: 'synthetic@example.invalid' });
    return { cpf: cpfDigits, phone, mac: '02' + seq.toString(16).padStart(10, '0') };
  }
  async function request(handler, body, headers = {}) {
    const r = await context[handler](new Request('https://portal.invalid/' + handler, { method: 'POST', headers, body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json(), retryAfter: r.headers.get('retry-after') };
  }
  async function init(person, headers = {}) {
    const r = await request('handleAttemptInit', { params: { id: person.mac, ap: 'AABBCCDDEEFF', ssid: 'Beta', store: 'povao' }, original_url: 'https://portal.invalid/' }, headers);
    if (r.status === 200) Object.assign(person, { attempt_id: r.body.attempt_id, resume_token: r.body.token });
    return r;
  }
  return { person, init, submit: (p, headers) => request('handleIdentity', p, headers), admitted, queriedRates, alreadyAdmitted, context,
    setRpcFailure: value => { rpcFailure = value; }, setStopBeforeJoin: value => { stopBeforeJoin = value; }, loseNextAdmissionReply: () => { loseNextReply = true; } };
}
async function receiptCount() { return (await client.query('select count(*)::int n from captive_identity_admissions')).rows[0].n; }
async function admit(person, origin = '198.51.100.10', c = client) {
  return (await c.query('select admit_captive_identity($1,$2,$3,$4) result', [person.attempt_id, person.resume_token,
    hash(`${person.cpf}:${person.phone}`), origin ? hash(origin) : null])).rows[0].result;
}
try {
  run('initdb.exe', ['-D', data, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
  server = spawn(path.join(bin, 'postgres.exe'), ['-D', data, '-h', options.host, '-p', String(options.port)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', x => logs += x); server.stderr.on('data', x => logs += x);
  server.once('error', e => serverError = e); server.once('exit', (code, signal) => serverExit = { code, signal });
  await new Promise((resolve, reject) => { server.once('spawn', resolve); server.once('error', reject); });
  for (let i = 0; i < 60; i++) {
    if (!alive()) throw new Error('HARNESS_PROCESS_NOT_RUNNING');
    try { client = await connect(); break; }
    catch (e) { if (e.message === 'HARNESS_CLUSTER_MISMATCH') throw e; await new Promise(r => setTimeout(r, 100)); }
  }
  if (!client) throw new Error('POSTGRES_START_FAILED');
  results.postgres = (await client.query('select version()')).rows[0].version;
  await client.query(`CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA extensions TO service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid primary key);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    CREATE TABLE public.rate_limits(key text primary key,window_start timestamptz not null,count integer not null,blocked_until timestamptz,updated_at timestamptz not null);`);
  await client.query(await readFile(path.join(root, 'supabase/migrations/20260822005502_fd26a4a8-59a5-40f4-bbfc-34f0158ee348.sql'), 'utf8'));
  await client.query('ALTER TABLE captive_auth_attempts ADD COLUMN store_id uuid, ADD COLUMN store_detection_source text');
  await client.query(limiterSql);
  await client.query(await readFile(path.join(root, 'supabase/migrations/20260926180137_nat_safe_identity_admission.sql'), 'utf8'));
  for (const count of [21, 300]) {
    await test(`${count} distinct clients traverse /attempt/init + /identify behind one NAT`, async () => {
      const h = harness();
      for (let n = 0; n < count; n++) {
        const p = h.person(), headers = { 'x-real-ip': '198.51.100.10' };
        assert.equal((await h.init(p, headers)).status, 200);
        assert.equal((await h.submit(p, headers)).status, 200);
      }
      assert.equal(h.admitted.length, count); assert.equal(await receiptCount(), count);
      assert.equal((await client.query("select count(*)::int n from rate_limits where key like 'identity:ip:%'")).rows[0].n, 0);
      results.observations.push({ shared_nat_clients: count, admitted: h.admitted.length });
    });
  }
  await test('21 clients without a public IP remain independent', async () => {
    const h = harness();
    for (let n = 0; n < 21; n++) { const p = h.person(); assert.equal((await h.init(p)).status, 200); assert.equal((await h.submit(p)).status, 200); }
    assert.equal(h.admitted.length, 21);
  });
  await test('/attempt/init bounds repeated capabilities for the same MAC without blocking peers', async () => {
    const h = harness(), p = h.person();
    for (let n = 0; n < 5; n++) assert.equal((await h.init(p)).status, 200);
    const denied = await h.init(p); assert.equal(denied.status, 429); assert.ok(Number(denied.retryAfter) > 290);
    const blocked = denied.retryAfter; assert.ok(Number((await h.init(p)).retryAfter) <= Number(blocked));
    assert.equal((await h.init(h.person())).status, 200);
  });
  await test('pre-join dependency failures retry without charging admission more than once', async () => {
    const h = harness(), p = h.person(); await h.init(p); h.setStopBeforeJoin(true);
    for (let n = 0; n < 10; n++) assert.equal((await h.submit(p)).status, 500);
    assert.equal(await receiptCount(), 1);
    assert.equal((await client.query("select max(count)::int n from rate_limits where key like 'identity:%' and key not like 'identity:request:%'")).rows[0].n, 1);
    h.setStopBeforeJoin(false); assert.equal((await h.submit(p)).status, 200); assert.equal(h.admitted.length, 1);
  });
  await test('lost RPC response after commit reuses the original receipt on retry', async () => {
    const h = harness(), p = h.person(); await h.init(p); h.loseNextAdmissionReply();
    assert.equal((await h.submit(p)).status, 503); assert.equal(await receiptCount(), 1); assert.equal(h.admitted.length, 0);
    assert.equal((await h.submit(p)).status, 200); assert.equal(await receiptCount(), 1); assert.equal(h.admitted.length, 1);
    const counts = (await client.query("select count from rate_limits where key like 'identity:%' and key not like 'identity:request:%'")).rows;
    assert.ok(counts.every(x => x.count === 1));
  });
  await test('same capability flood is bounded and Retry-After never slides while blocked', async () => {
    const h = harness(), p = h.person(); await h.init(p); h.setStopBeforeJoin(true);
    for (let n = 0; n < 20; n++) assert.equal((await h.submit(p)).status, 500);
    const denied = await h.submit(p); assert.equal(denied.status, 429); assert.ok(Number(denied.retryAfter) > 55);
    const block = (await client.query("select blocked_until from rate_limits where key=$1", ['identity:request:' + p.attempt_id])).rows[0].blocked_until;
    assert.equal((await h.submit(p)).status, 429);
    assert.equal((await client.query("select blocked_until from rate_limits where key=$1", ['identity:request:' + p.attempt_id])).rows[0].blocked_until.toISOString(), block.toISOString());
    await client.query("update rate_limits set blocked_until=clock_timestamp()-interval '1 second',window_start=clock_timestamp()-interval '61 seconds' where key=$1", ['identity:request:' + p.attempt_id]);
    h.setStopBeforeJoin(false); assert.equal((await h.submit(p)).status, 200);
  });
  await test('admitted capability bypasses every limiter and does not authorize again', async () => {
    const h = harness(), p = h.person(); await h.init(p); assert.equal((await h.submit(p)).status, 200);
    const count = h.queriedRates.length; h.setRpcFailure(true);
    for (let n = 0; n < 25; n++) assert.equal((await h.submit(p)).status, 200);
    assert.equal(h.queriedRates.length, count); assert.equal(h.admitted.length, 1);
  });
  await test('8 identities per persisted device are allowed; ninth cannot spoof its MAC in identify', async () => {
    const h = harness(), device = h.person(); await h.init(device);
    for (let n = 0; n < 8; n++) {
      const p = { ...h.person(), attempt_id: device.attempt_id, resume_token: device.resume_token };
      assert.equal((await admit(p)).allowed, true);
    }
    const p = { ...h.person(), attempt_id: device.attempt_id, resume_token: device.resume_token, client_mac: '021111111111', client_ip: '203.0.113.99' };
    const denied = await h.submit(p); assert.equal(denied.status, 429); assert.ok(Number(denied.retryAfter) > 290);
    assert.equal(await receiptCount(), 8);
    const fresh = h.person(); await h.init(fresh); assert.equal((await h.submit(fresh)).status, 200);
  });
  await test('identity limit blocks ninth capability with no debit in unrelated dimensions', async () => {
    const h = harness(), identity = h.person();
    for (let n = 0; n < 8; n++) {
      const p = { ...h.person(), cpf: identity.cpf, phone: identity.phone }; await h.init(p); assert.equal((await admit(p)).allowed, true);
    }
    const p = { ...h.person(), cpf: identity.cpf, phone: identity.phone }; await h.init(p);
    const denied = await admit(p); assert.equal(denied.allowed, false);
    assert.ok(Date.parse(denied.blocked_until) > Date.now() + 890000);
    assert.equal((await client.query("select count from rate_limits where key=$1", ['identity:device:' + store + ':' + p.mac.toUpperCase()])).rows[0].count, 0);
    assert.equal((await client.query("select count from rate_limits where key like 'identity:origin:%'")).rows[0].count, 8);
    const again = await admit(p); assert.equal(again.blocked_until, denied.blocked_until);
    await client.query("update rate_limits set blocked_until=clock_timestamp()-interval '1 second',window_start=clock_timestamp()-interval '901 seconds' where key=$1", ['identity:value:' + hash(`${p.cpf}:${p.phone}`)]);
    assert.equal((await admit(p)).allowed, true);
  });
  await test('emergency origin budget remains bounded and is separate for another store', async () => {
    const h = harness(), p = h.person(); await h.init(p);
    const originKey = 'identity:origin:' + store + ':' + hash('198.51.100.10');
    await client.query('insert into rate_limits values($1,clock_timestamp(),1000,NULL,clock_timestamp())', [originKey]);
    const denied = await admit(p); assert.equal(denied.allowed, false); assert.equal(await receiptCount(), 0);
    const windowEnd = (await client.query("select window_start+interval '300 seconds' until from rate_limits where key=$1", [originKey])).rows[0].until;
    assert.equal(Date.parse(denied.blocked_until), windowEnd.getTime());
    assert.equal((await admit(p)).blocked_until, denied.blocked_until);
    const untouched = (await client.query("select count from rate_limits where key like 'identity:device:%' or key like 'identity:value:%'")).rows;
    assert.ok(untouched.every(r => r.count === 0));
    const peer = h.person(); await h.init(peer);
    await client.query('update captive_auth_attempts set store_id=$2 where id=$1', [peer.attempt_id, randomUUID()]);
    assert.equal((await admit(peer)).allowed, true);
    await client.query("update rate_limits set window_start=clock_timestamp()-interval '301 seconds',blocked_until=clock_timestamp()-interval '1 second' where key=$1", [originKey]);
    assert.equal((await admit(p)).allowed, true);
    assert.equal((await client.query('select count from rate_limits where key=$1', [originKey])).rows[0].count, 1);
  });
  await test('concurrent origin boundary admits only the four remaining slots of 1000', async () => {
    const h = harness(), people = [];
    for (let n = 0; n < 12; n++) { const p = h.person(); await h.init(p); people.push(p); }
    const originKey = 'identity:origin:' + store + ':' + hash('198.51.100.10');
    await client.query('insert into rate_limits values($1,clock_timestamp(),996,NULL,clock_timestamp())', [originKey]);
    const clients = await Promise.all(people.map(() => connect()));
    const r = await Promise.all(people.map((p, i) => admit(p, '198.51.100.10', clients[i])));
    assert.equal(r.filter(x => x.allowed).length, 4); assert.equal(await receiptCount(), 4);
    assert.equal((await client.query('select count from rate_limits where key=$1', [originKey])).rows[0].count, 1000);
    assert.equal((await client.query("select sum(count)::int n from rate_limits where key like 'identity:device:%'")).rows[0].n, 4);
    assert.equal((await client.query("select sum(count)::int n from rate_limits where key like 'identity:value:%'")).rows[0].n, 4);
  });
  await test('concurrent identical admission has one receipt and one debit in all three dimensions', async () => {
    const h = harness(), p = h.person(); await h.init(p);
    const clients = await Promise.all(Array.from({ length: 12 }, () => connect()));
    const r = await Promise.all(clients.map(c => admit(p, '198.51.100.10', c)));
    assert.ok(r.every(x => x.allowed)); assert.equal(r.filter(x => !x.replay).length, 1); assert.equal(await receiptCount(), 1);
    const counters = (await client.query("select count from rate_limits where key like 'identity:%' and key not like 'identity:request:%'")).rows;
    assert.equal(counters.length, 3); assert.ok(counters.every(x => x.count === 1));
  });
  await test('concurrent distinct capabilities cannot exceed one identity quota', async () => {
    const h = harness(), identity = h.person(), people = [];
    for (let n = 0; n < 12; n++) { const p = { ...h.person(), cpf: identity.cpf, phone: identity.phone }; await h.init(p); people.push(p); }
    const clients = await Promise.all(people.map(() => connect()));
    const r = await Promise.all(people.map((p, i) => admit(p, '198.51.100.10', clients[i])));
    assert.equal(r.filter(x => x.allowed).length, 8); assert.equal(await receiptCount(), 8);
  });
  await test('invalid, expired and cancelled capabilities never debit or reuse receipts', async () => {
    const h = harness(), p = h.person(); await h.init(p); assert.equal((await admit(p)).allowed, true);
    assert.equal((await admit({ ...p, resume_token: 'a'.repeat(64) })).invalid_attempt, true);
    await client.query("update captive_auth_attempts set status='cancelled' where id=$1", [p.attempt_id]);
    assert.equal((await admit(p)).invalid_attempt, true);
    await client.query("update captive_auth_attempts set status='created',expires_at=clock_timestamp()-interval '1 second' where id=$1", [p.attempt_id]);
    assert.equal((await admit(p)).invalid_attempt, true); assert.equal((await h.submit(p)).status, 403);
    assert.equal((await client.query("select count from rate_limits where key=$1", ['identity:request:' + p.attempt_id])).rows[0].count, 1);
  });
  await test('a receipt cannot be replayed after its stored device context changes', async () => {
    const h = harness(), p = h.person(); await h.init(p); assert.equal((await admit(p)).allowed, true);
    await client.query("update captive_auth_attempts set client_mac='021111111111' where id=$1", [p.attempt_id]);
    assert.equal((await admit(p)).invalid_attempt, true); assert.equal((await h.submit(p)).status, 403);
  });
  for (const replay of [false, true]) {
    await test(`capability expiring while blocked on ${replay ? 'request/replay' : 'origin/admission'} lock is rejected`, async () => {
      const h = harness(), p = h.person(); await h.init(p);
      if (replay) await admit(p);
      const key = replay ? 'identity:request:' + p.attempt_id : 'identity:origin:' + store + ':' + hash('198.51.100.10');
      await client.query('insert into rate_limits values($1,clock_timestamp(),0,NULL,clock_timestamp()) on conflict(key) do nothing', [key]);
      const blocker = await connect(), waiter = await connect();
      await blocker.query('BEGIN');
      await blocker.query('select * from rate_limits where key=$1 FOR UPDATE', [key]);
      await client.query("update captive_auth_attempts set expires_at=clock_timestamp()+interval '500 milliseconds' where id=$1", [p.attempt_id]);
      const pending = admit(p, '198.51.100.10', waiter);
      try {
        let waiting = false;
        for (let n = 0; n < 50; n++) {
          const row = (await client.query('select wait_event_type from pg_stat_activity where pid=$1', [waiter.processID])).rows[0];
          if (row?.wait_event_type === 'Lock') { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true, 'Probe must observe the real blocking lock');
        await client.query("select pg_sleep(greatest(0,extract(epoch from(expires_at-clock_timestamp())))+0.05) from captive_auth_attempts where id=$1", [p.attempt_id]);
      } finally { await blocker.query('ROLLBACK'); }
      const r = await pending; assert.equal(r.allowed, false); assert.equal(r.invalid_attempt, true);
      assert.equal(await receiptCount(), replay ? 1 : 0);
      const counts = (await client.query("select count from rate_limits where key like 'identity:%' and key not like 'identity:request:%'")).rows;
      assert.ok(counts.every(x => x.count === (replay ? 1 : 0)));
    });
  }
  await test('a database failure fails closed before profile lookup and admission', async () => {
    const h = harness(), p = h.person(); await h.init(p); h.setRpcFailure(true);
    const r = await h.submit(p); assert.equal(r.status, 503); assert.equal(r.body.code, 'rate_limit_unavailable');
    assert.equal(h.admitted.length, 0); assert.equal(await receiptCount(), 0);
  });
  await test('quota receipts are inaccessible to public roles and cascade with attempt retention', async () => {
    const security = (await client.query(`select has_function_privilege('anon','public.admit_captive_identity(uuid,text,text,text)','execute') anon_exec,
      has_function_privilege('authenticated','public.admit_captive_identity(uuid,text,text,text)','execute') auth_exec,
      has_table_privilege('anon','public.captive_identity_admissions','select') anon_read,
      (select relrowsecurity from pg_class where oid='public.captive_identity_admissions'::regclass) rls`)).rows[0];
    assert.deepEqual(security, { anon_exec: false, auth_exec: false, anon_read: false, rls: true });
    const h = harness(), p = h.person(); await h.init(p);
    await client.query('SET ROLE service_role');
    try { assert.equal((await admit(p)).allowed, true); } finally { await client.query('RESET ROLE'); }
    assert.equal(await receiptCount(), 1);
    await client.query('delete from captive_auth_attempts where id=$1', [p.attempt_id]); assert.equal(await receiptCount(), 0);
  });
  results.finished_at = new Date().toISOString();
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ passed: results.passed.length, failed: results.failed.length, observations: results.observations }));
  if (results.failed.length) process.exitCode = 1;
} catch (e) { console.error(e); process.exitCode = 1; }
finally {
  await Promise.all(connections.map(c => c.end().catch(() => {})));
  if (alive()) {
    try { if (await ownedPid() && alive()) run('pg_ctl.exe', ['-D', data, 'stop', '-m', 'fast', '-w']); else server.kill(); }
    catch (e) { console.error('Owned PostgreSQL cleanup failed', e); process.exitCode = 1; if (alive()) server.kill(); }
  }
  await writeFile(path.join(artifacts, 'server-last.log'), logs);
}
