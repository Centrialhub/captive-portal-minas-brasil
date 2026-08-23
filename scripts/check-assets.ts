import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const CWD = process.cwd();

function checkAsset(path: string, minSize = 0) {
  const fullPath = join(CWD, path);
  if (!existsSync(fullPath)) {
    console.error(`❌ Missing mandatory asset: ${path}`);
    process.exit(1);
  }
  const stats = readFileSync(fullPath);
  if (stats.length <= minSize) {
    console.error(`❌ Asset is empty or corrupted: ${path}`);
    process.exit(1);
  }
  console.log(`✅ Asset OK: ${path} (${stats.length} bytes)`);
}

console.log("Starting integrity check...");

checkAsset('src/assets/logo-minas-brasil.png', 100);
checkAsset('public/favicon-mb.png', 100);
checkAsset('public/favicon.ico', 100);

const indexHtml = readFileSync(join(CWD, 'index.html'), 'utf8');
if (!indexHtml.includes('/favicon-mb.png')) {
  console.error("❌ index.html does not reference /favicon-mb.png");
  process.exit(1);
}

try {
  console.log("Checking TypeScript/Import resolution...");
  execSync('npm run typecheck', { stdio: 'inherit' });
  console.log("✅ Typecheck passed.");
} catch (_) {
  console.error("❌ Typecheck failed - possible import resolution error.");
  process.exit(1);
}

console.log("All integrity checks passed.");
