import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const FORBIDDEN_PHRASES = [
  'PROMPT FINALIZADO',
  '100% pronto',
  'GATE DE SEGURANÇA ALCANÇADO'
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
      for (const phrase of FORBIDDEN_PHRASES) {
        if (content.includes(phrase)) {
          console.error(`❌ Forbidden phrase found in ${fullPath}: "${phrase}"`);
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
