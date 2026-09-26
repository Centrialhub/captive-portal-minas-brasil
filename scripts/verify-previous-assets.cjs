const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { restorePreviousAssets } = require('./restore-previous-assets.cjs');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'compat/previous-frontend');
const canonical = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-compat-test-'));
  const snapshotDir = path.join(caseDir, 'snapshot');
  const dist = path.join(caseDir, 'dist');
  fs.mkdirSync(snapshotDir);
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  for (const file of ['manifest.json', ...canonical.assets.map(asset => asset.gzip)]) {
    fs.copyFileSync(path.join(source, file), path.join(snapshotDir, file));
  }
  fs.copyFileSync(path.join(root, 'src/assets/logo-minas-brasil.png'), path.join(dist, canonical.requiredAssets[0].path.slice(1)));
  const manifest = structuredClone(canonical);
  const save = () => fs.writeFileSync(path.join(snapshotDir, 'manifest.json'), JSON.stringify(manifest));
  t.after(() => {
    const resolved = path.resolve(caseDir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('portal-compat-test-'));
    fs.rmSync(resolved, { recursive: true });
  });
  return { dist, snapshotDir, manifest, save, run: () => restorePreviousAssets(dist, { snapshotDir }) };
}

test('restores exact previous release and is idempotent without changing current assets', t => {
  const f = fixture(t);
  const current = path.join(f.dist, 'assets/index-current123.js');
  fs.writeFileSync(current, 'current release');
  assert.deepEqual(f.run(), { releaseSha: canonical.releaseSha, restored: 2, verified: 2 });
  for (const entry of canonical.assets) {
    const bytes = fs.readFileSync(path.join(f.dist, entry.path.slice(1)));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(digest(bytes), entry.sha256);
  }
  assert.deepEqual(f.run(), { releaseSha: canonical.releaseSha, restored: 0, verified: 2 });
  assert.equal(fs.readFileSync(current, 'utf8'), 'current release');
});

test('rejects compressed tampering before decompression', t => {
  const f = fixture(t);
  const filename = path.join(f.snapshotDir, f.manifest.assets[0].gzip);
  const compressed = fs.readFileSync(filename);
  compressed[compressed.length - 1] ^= 1;
  fs.writeFileSync(filename, compressed);
  assert.throws(f.run, /compressed checksum mismatch/);
});

test('rejects incorrect uncompressed checksum', t => {
  const f = fixture(t);
  f.manifest.assets[0].sha256 = 'a'.repeat(64);
  f.save();
  assert.throws(f.run, /asset checksum mismatch/);
});

test('bounds decompression by the declared validated output size', t => {
  const f = fixture(t);
  const entry = f.manifest.assets[0];
  const compressed = zlib.gzipSync(Buffer.alloc(256 * 1024, 65));
  entry.bytes = 100;
  entry.gzipBytes = compressed.length;
  entry.gzipSha256 = digest(compressed);
  fs.writeFileSync(path.join(f.snapshotDir, entry.gzip), compressed);
  f.save();
  assert.throws(f.run, error => error.code === 'ERR_BUFFER_TOO_LARGE');
});

test('rejects an oversized decompression limit in the manifest', t => {
  const f = fixture(t);
  f.manifest.assets[0].bytes = 512 * 1024 + 1;
  f.save();
  assert.throws(f.run, /invalid asset size/);
});

for (const invalidPath of ['/assets/../escape.js', '/assets/subdir/index.js', '/assets\\index.js', 'C:/Windows/escape.js']) {
  test(`rejects destination outside a strict asset basename: ${invalidPath}`, t => {
    const f = fixture(t);
    f.manifest.assets[0].path = invalidPath;
    f.save();
    assert.throws(f.run, /strict \/assets\/ basename/);
  });
}

test('rejects compressed paths outside the snapshot directory', t => {
  const f = fixture(t);
  f.manifest.assets[0].gzip = '../escape.gz';
  f.save();
  assert.throws(f.run, /gzip path must match/);
});

test('never overwrites a divergent current file or partially restores another asset', t => {
  const f = fixture(t);
  const target = path.join(f.dist, f.manifest.assets[1].path.slice(1));
  fs.writeFileSync(target, 'different current CSS');
  assert.throws(f.run, /refusing to overwrite different current asset/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'different current CSS');
  assert.equal(fs.existsSync(path.join(f.dist, f.manifest.assets[0].path.slice(1))), false);
});

test('requires the exact transitive logo before writing any snapshots', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dist, f.manifest.requiredAssets[0].path.slice(1)), 'wrong logo');
  assert.throws(f.run, /shared dependency mismatch/);
  assert.equal(fs.existsSync(path.join(f.dist, f.manifest.assets[0].path.slice(1))), false);
});

test('rejects an undeclared transitive asset even when dependency bytes are valid', t => {
  const f = fixture(t);
  const original = path.join(f.dist, f.manifest.requiredAssets[0].path.slice(1));
  f.manifest.requiredAssets[0].path = '/assets/other-logo.png';
  fs.renameSync(original, path.join(f.dist, f.manifest.requiredAssets[0].path.slice(1)));
  f.save();
  assert.throws(f.run, /undeclared transitive asset/);
});

test('rejects a release other than the explicitly retained predecessor', t => {
  const f = fixture(t);
  f.manifest.releaseSha = '0'.repeat(40);
  f.save();
  assert.throws(f.run, /unexpected snapshot release or schema/);
});
