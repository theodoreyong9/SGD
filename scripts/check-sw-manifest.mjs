// scripts/check-sw-manifest.mjs — fails CI if sw.js references a shell file
// that doesn't exist on disk (catches drift between the two on every push).

import { readFileSync, existsSync } from 'node:fs';

const src = readFileSync('sw.js', 'utf8');
const match = src.match(/SHELL_FILES\s*=\s*\[([\s\S]*?)\]/);
if (!match) {
  console.error('Could not find SHELL_FILES array in sw.js');
  process.exit(1);
}

const entries = [...match[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
let failed = false;

for (const entry of entries) {
  if (entry === './') continue; // resolves to index.html, already checked separately
  const path = entry.replace(/^\.\//, '');
  if (!existsSync(path)) {
    console.error(`MISSING: sw.js precaches "${entry}" but ${path} does not exist`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
} else {
  console.log(`sw.js precache list OK (${entries.length} entries checked)`);
}
