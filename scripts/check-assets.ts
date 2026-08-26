import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

  const isPng = stats.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isIco = stats.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00]));
  const validSignature = asset.mime === "image/png" ? isPng : isIco;
  if (!validSignature) {
    console.error(`FAIL: ${asset.path} does not match ${asset.mime}.`);
    process.exit(1);
  }

  const sha = createHash("sha256").update(stats).digest("hex");
  console.log(`OK: ${asset.path} | Size: ${stats.length} bytes | SHA-256: ${sha}`);
});

console.log('--- All mandatory assets are present and valid ---');
