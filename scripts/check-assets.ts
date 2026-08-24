import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const assets = [
  { path: 'src/assets/logo-minas-brasil.png', mime: 'image/png' },
  { path: 'public/favicon-mb.png', mime: 'image/png' },
  { path: 'public/favicon.ico', mime: 'image/x-icon' }
];

console.log('--- Asset Integrity Check ---');

assets.forEach(asset => {
  const fullPath = join(process.cwd(), asset.path);
  
  if (!existsSync(fullPath)) {
    console.error(`FAIL: ${asset.path} is missing.`);
    process.exit(1);
  }

  const stats = readFileSync(fullPath);
  if (stats.length === 0) {
    console.error(`FAIL: ${asset.path} is empty.`);
    process.exit(1);
  }

  const fileType = execSync(`file --mime-type -b ${fullPath}`).toString().trim();
  if (fileType !== asset.mime && !fileType.startsWith('image/')) {
     // icon resource might be detected differently by 'file' utility on some systems
     console.warn(`WARN: ${asset.path} MIME type detected as ${fileType}, expected ${asset.mime}`);
  }

  const sha = execSync(`sha256sum ${fullPath}`).toString().split(' ')[0];
  console.log(`OK: ${asset.path} | Size: ${stats.length} bytes | SHA-256: ${sha}`);
});

console.log('--- All mandatory assets are present and valid ---');
