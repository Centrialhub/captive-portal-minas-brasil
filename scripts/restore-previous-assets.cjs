const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const SNAPSHOT_DIR = path.resolve(__dirname, '../compat/previous-frontend');
const PREVIOUS_RELEASE = '153dd87ae34f0c9adc3b6454e4368d8c5949c836';
const MAX_COMPRESSED_BYTES = 256 * 1024;
const MAX_ASSET_BYTES = 512 * 1024;
const MAX_DEPENDENCY_BYTES = 5 * 1024 * 1024;
const ASSET_PATH = /^\/assets\/([A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|css|png))$/;
const SHA256 = /^[0-9a-f]{64}$/;

function requireCondition(condition, message) {
  if (!condition) throw new Error(`Previous frontend assets: ${message}`);
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function regularFile(filename, limit) {
  const stat = fs.lstatSync(filename);
  requireCondition(stat.isFile() && !stat.isSymbolicLink(), `expected a regular file: ${path.basename(filename)}`);
  requireCondition(stat.size > 0 && stat.size <= limit, `file exceeds size limit: ${path.basename(filename)}`);
  return fs.readFileSync(filename);
}

function assetName(entry, limit) {
  requireCondition(entry && typeof entry === 'object', 'invalid manifest entry');
  const match = typeof entry.path === 'string' && ASSET_PATH.exec(entry.path);
  requireCondition(match && !entry.path.includes('..'), 'asset path must be a strict /assets/ basename');
  requireCondition(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= limit, 'invalid asset size');
  requireCondition(typeof entry.sha256 === 'string' && SHA256.test(entry.sha256), 'invalid asset SHA256');
  return match[1];
}

// The optional snapshot directory exists for isolated tests. Production always
// uses the checked-in, pinned snapshot; no network access is performed.
function restorePreviousAssets(distPath, { snapshotDir = SNAPSHOT_DIR } = {}) {
  const manifestBytes = regularFile(path.join(snapshotDir, 'manifest.json'), 16 * 1024);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  requireCondition(manifest.schemaVersion === 1 && manifest.releaseSha === PREVIOUS_RELEASE, 'unexpected snapshot release or schema');
  requireCondition(Array.isArray(manifest.assets) && manifest.assets.length === 2, 'expected exactly one JavaScript and one CSS snapshot');
  requireCondition(Array.isArray(manifest.requiredAssets) && manifest.requiredAssets.length === 1, 'expected the shared logo dependency');

  const assetDirectory = path.join(path.resolve(distPath), 'assets');
  const directoryStat = fs.lstatSync(assetDirectory);
  requireCondition(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), 'dist/assets must be a real directory');
  const planned = [];
  const seen = new Set();
  for (const entry of manifest.assets) {
    const name = assetName(entry, MAX_ASSET_BYTES);
    requireCondition(/\.(?:js|css)$/.test(name) && !seen.has(name), 'duplicate or unsupported snapshot asset');
    seen.add(name);
    requireCondition(entry.gzip === `${name}.gz`, 'gzip path must match the asset basename');
    requireCondition(Number.isSafeInteger(entry.gzipBytes) && entry.gzipBytes > 0 && entry.gzipBytes <= MAX_COMPRESSED_BYTES, 'invalid compressed size');
    requireCondition(typeof entry.gzipSha256 === 'string' && SHA256.test(entry.gzipSha256), 'invalid compressed SHA256');
    const compressed = regularFile(path.join(snapshotDir, entry.gzip), MAX_COMPRESSED_BYTES);
    requireCondition(compressed.length === entry.gzipBytes && digest(compressed) === entry.gzipSha256, `compressed checksum mismatch: ${name}`);
    const bytes = zlib.gunzipSync(compressed, { maxOutputLength: entry.bytes });
    requireCondition(bytes.length === entry.bytes && digest(bytes) === entry.sha256, `asset checksum mismatch: ${name}`);
    const target = path.join(assetDirectory, name);
    if (fs.existsSync(target)) {
      const current = regularFile(target, MAX_ASSET_BYTES);
      requireCondition(current.equals(bytes), `refusing to overwrite different current asset: ${name}`);
    }
    planned.push({ target, name, bytes });
  }
  requireCondition(planned.some(({ name }) => name.endsWith('.js')) && planned.some(({ name }) => name.endsWith('.css')), 'snapshot must contain JavaScript and CSS');

  for (const entry of manifest.requiredAssets) {
    const name = assetName(entry, MAX_DEPENDENCY_BYTES);
    requireCondition(name.endsWith('.png') && !seen.has(name), 'unsupported or duplicate shared dependency');
    seen.add(name);
    const bytes = regularFile(path.join(assetDirectory, name), MAX_DEPENDENCY_BYTES);
    requireCondition(bytes.length === entry.bytes && digest(bytes) === entry.sha256, `shared dependency mismatch: ${name}`);
  }
  for (const { bytes, name } of planned) {
    const references = bytes.toString('utf8').match(/\/assets\/[A-Za-z0-9._-]+/g) || [];
    requireCondition(references.every((reference) => seen.has(path.posix.basename(reference))), `undeclared transitive asset in ${name}`);
  }

  // Validation is complete before writing. Exclusive creation also prevents a
  // concurrent build from having its assets silently replaced.
  let restored = 0;
  for (const { target, bytes } of planned) {
    if (fs.existsSync(target)) continue;
    fs.writeFileSync(target, bytes, { flag: 'wx' });
    restored++;
  }
  return { releaseSha: manifest.releaseSha, restored, verified: planned.length };
}

module.exports = { restorePreviousAssets };
