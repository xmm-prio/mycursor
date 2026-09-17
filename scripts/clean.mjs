/**
 * Removes build output and verification scratch directories.
 *
 * The sandbox verification leaves a ~100 MB shadow copy of Cursor behind on
 * purpose, so a failure can be inspected afterwards. This is how it gets
 * reclaimed.
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const targets = [join(repoRoot, '.verify-out'), join(repoRoot, '.tmp')];

const packagesDir = join(repoRoot, 'packages');
if (existsSync(packagesDir)) {
  for (const name of readdirSync(packagesDir)) {
    targets.push(join(packagesDir, name, 'dist'));
    targets.push(join(packagesDir, name, 'tsconfig.tsbuildinfo'));
  }
}

let reclaimed = 0;
for (const target of targets) {
  if (!existsSync(target)) continue;
  reclaimed += measure(target);
  rmSync(target, { recursive: true, force: true });
  console.log(`removed ${target.replace(repoRoot, '.')}`);
}

console.log(`\nreclaimed ${(reclaimed / 1048576).toFixed(1)} MiB`);

function measure(path) {
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    total += measure(join(path, entry.name));
  }
  return total;
}
