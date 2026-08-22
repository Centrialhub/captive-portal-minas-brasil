const fs = require('fs');
const path = require('path');

const distPath = path.resolve(__dirname, 'dist');
if (!fs.existsSync(distPath)) {
  fs.mkdirSync(distPath, { recursive: true });
}

const buildInfo = {
  sha: process.env.COMMIT_SHA || 'dev',
  timestamp: new Date().toISOString(),
  build: 'production'
};

fs.writeFileSync(
  path.join(distPath, 'build-info.json'),
  JSON.stringify(buildInfo, null, 2)
);

console.log('Build info generated at dist/build-info.json');
