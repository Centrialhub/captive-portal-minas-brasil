import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const FORBIDDEN_REGEXES = [
  /PROMPT\s+.*\s+FINALIZADO/i,
  /100%\s+pronto/i,
  /GATE\s+DE\s+SEGURANÇA\s+ALCANÇADO/i
];

function scanDir(dir: string) {
  const files = readdirSync(dir);
  for (const file of files) {
    const fullPath = join(dir, file);
    if (statSync(fullPath).isDirectory()) {
      if (file !== 'node_modules' && file !== '.git') {
        scanDir(fullPath);
      }
    } else if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.html')) {
      const content = readFileSync(fullPath, 'utf8');
      for (const regex of FORBIDDEN_REGEXES) {
        if (regex.test(content)) {
          console.error(`❌ Forbidden phrase (regex ${regex}) found in ${fullPath}`);
          process.exit(1);
        }
      }
    }
  }
}

console.log("Scanning for non-functional claims in src/ and supabase/functions/...");
scanDir(join(process.cwd(), 'src'));
scanDir(join(process.cwd(), 'supabase/functions'));
console.log("✅ No forbidden claims found.");
