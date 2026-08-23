const fs = require('fs');
const path = require('path');

const distPath = path.resolve(__dirname, '../dist');
if (!fs.existsSync(distPath)) {
  fs.mkdirSync(distPath, { recursive: true });
}

const sha = process.env.COMMIT_SHA || 'dev';
if (!sha || sha === 'unknown') {
  console.error('ERROR: COMMIT_SHA must be a real value for production build-info');
  process.exit(1);
}

const buildInfo = {
  sha: sha,
  timestamp: new Date().toISOString(),
  build: 'production'
};

fs.writeFileSync(
  path.join(distPath, 'build-info.json'),
  JSON.stringify(buildInfo, null, 2)
);

console.log('Build info generated at dist/build-info.json');
