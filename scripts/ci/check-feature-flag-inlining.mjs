#!/usr/bin/env node
/**
 * Verifies that NEXT_PUBLIC_PHAROS_* feature flags are inlined at build time.
 *
 * Background: `src/lib/feature-flags.ts` reads each flag via direct dot-syntax
 * (`process.env.NEXT_PUBLIC_PHAROS_FOO === "true"`). Next.js statically
 * replaces those expressions with their compile-time values, so the literal
 * env-var name should not appear in the client bundle. A regression to dynamic
 * bracket access (`process.env[name]`) leaves the lookup intact at runtime,
 * resolving against an empty browser polyfill so every flag silently becomes
 * `false`.
 *
 * The check greps `.next/static/chunks/*.js` for any `NEXT_PUBLIC_PHAROS_*`
 * literal string. Zero hits == healthy. Any hit means the flag is being read
 * dynamically.
 *
 * Run AFTER `npm run build` (wired into PAGES_VALIDATE_COMMANDS in
 * scripts/lib/validate-contract.mjs).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CHUNKS_DIR = ".next/static/chunks";
const FLAG_PATTERN = /NEXT_PUBLIC_PHAROS_[A-Z_]+/g;

function listChunkFiles(dir) {
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    process.stderr.write(
      `check-feature-flag-inlining: ${dir} not found — did you run \`npm run build\` first?\n`,
    );
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    process.stderr.write(`check-feature-flag-inlining: ${dir} is not a directory\n`);
    process.exit(1);
  }
  const files = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const s = statSync(path);
      if (s.isDirectory()) walk(path);
      else if (s.isFile() && name.endsWith(".js")) files.push(path);
    }
  };
  walk(dir);
  return files;
}

const files = listChunkFiles(CHUNKS_DIR);
const offenders = new Map();

for (const file of files) {
  const content = readFileSync(file, "utf8");
  const matches = content.match(FLAG_PATTERN);
  if (!matches) continue;
  const unique = new Set(matches);
  for (const flag of unique) {
    if (!offenders.has(flag)) offenders.set(flag, []);
    offenders.get(flag).push(file);
  }
}

if (offenders.size === 0) {
  process.stdout.write(
    `check-feature-flag-inlining: all NEXT_PUBLIC_PHAROS_* flags inlined across ${files.length} chunks.\n`,
  );
  process.exit(0);
}

process.stderr.write(
  "check-feature-flag-inlining: feature-flag names appear as runtime strings in compiled chunks.\n",
);
process.stderr.write(
  "This means at least one flag is being read via dynamic `process.env[name]` access and will\n",
);
process.stderr.write(
  "silently be `false` in the browser. Switch the read site to `process.env.NEXT_PUBLIC_X` literal.\n",
);
process.stderr.write("\nOffending flags and chunks:\n");
for (const [flag, hits] of offenders) {
  process.stderr.write(`  ${flag}\n`);
  for (const f of hits.slice(0, 3)) {
    process.stderr.write(`    - ${f}\n`);
  }
  if (hits.length > 3) {
    process.stderr.write(`    ... ${hits.length - 3} more chunk(s)\n`);
  }
}
process.exit(1);
