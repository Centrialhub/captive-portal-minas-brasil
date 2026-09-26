const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { restorePreviousAssets } = require('./restore-previous-assets.cjs');

const distPath = path.resolve(__dirname, '../dist');
if (!fs.existsSync(distPath)) {
  fs.mkdirSync(distPath, { recursive: true });
}

const sha = process.env.COMMIT_SHA || process.env.GIT_SHA || 'dev';
if (!sha || sha === 'unknown') {
  console.error('ERROR: COMMIT_SHA or GIT_SHA must be a real value for production build-info');
  process.exit(1);
}

const buildInfo = {
  sha: sha,
  timestamp: new Date().toISOString(),
  build: 'production'
};

const retained = restorePreviousAssets(distPath);
console.log(`Previous frontend assets verified: ${retained.verified} (${retained.releaseSha})`);

// Hash the exact final HTML bytes, including whitespace inside the script.
// Nginx uses this hash to allow only this inline script, never unsafe-inline.
const html = fs.readFileSync(path.join(distPath, 'index.html'), 'utf8');
const boot = html.match(/<script id="portal-boot">([\s\S]*?)<\/script>/);
if (!boot) throw new Error('Production HTML is missing inline startup protection');
const moduleOffset = html.search(/<script\b[^>]*type="module"/);
if (moduleOffset < 0 || html.indexOf(boot[0]) > moduleOffset) throw new Error('Startup protection must precede module dependencies');
const bootHash = crypto.createHash('sha256').update(boot[1], 'utf8').digest('base64');
fs.writeFileSync(path.join(distPath, 'portal-boot.sha256'), bootHash + '\n');

fs.writeFileSync(
  path.join(distPath, 'build-info.json'),
  JSON.stringify(buildInfo, null, 2)
);

console.log('Build info generated at dist/build-info.json');
