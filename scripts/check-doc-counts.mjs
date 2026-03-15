#!/usr/bin/env node
/**
 * CI guard: detects stale hardcoded stablecoin counts in primary docs.
 * Reads CANONICAL_ORDER length and SHADOW_STABLECOINS length from source,
 * then checks key docs for matching counts.
 *
 * Usage: node scripts/check-doc-counts.mjs
 * Exits 0 if all counts match, 1 if any are stale.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// --- Extract authoritative counts from source ---

const canonicalSrc = readFileSync(
  resolve(root, "shared/lib/stablecoins/index.ts"),
  "utf-8",
);
// Extract CANONICAL_ORDER array body, then count entries within it
const arrayMatch = canonicalSrc.match(
  /CANONICAL_ORDER:\s*string\[\]\s*=\s*\[([\s\S]*?)\];/,
);
if (!arrayMatch) {
  console.error("FATAL: Could not find CANONICAL_ORDER array in index.ts");
  process.exit(1);
}
const trackedCount = (arrayMatch[1].match(/^\s+"[a-z][a-z0-9-]*"/gm) || []).length;

const shadowSrc = readFileSync(
  resolve(root, "shared/lib/shadow-stablecoins.ts"),
  "utf-8",
);
const shadowCount = (shadowSrc.match(/\{\s*id:\s*"/g) || []).length;

const psiCount = trackedCount + shadowCount;

console.log(
  `Authoritative counts: ${trackedCount} tracked, ${shadowCount} shadow, ${psiCount} PSI-eligible`,
);

// --- Check primary docs for stale counts ---

const CHECKS = [
  {
    file: "CLAUDE.md",
    pattern: /tracking (\d+) stablecoins/,
    expected: trackedCount,
    label: "tracked",
  },
  {
    file: "AGENTS.md",
    pattern: /tracking (\d+) stablecoins/,
    expected: trackedCount,
    label: "tracked",
  },
  {
    file: "README.md",
    pattern: /tracking (\d+) stablecoins/,
    expected: trackedCount,
    label: "tracked",
  },
  {
    file: "docs/report-cards.md",
    pattern: /(\d+) tracked/,
    expected: trackedCount,
    label: "tracked",
  },
  {
    file: "docs/supply-snapshot.md",
    pattern: /currently (\d+) entries/,
    expected: psiCount,
    label: "PSI-eligible",
  },
  {
    file: "docs/supply-snapshot.md",
    pattern: /(\d+) tracked/,
    expected: trackedCount,
    label: "tracked",
  },
];

let failures = 0;

for (const { file, pattern, expected, label } of CHECKS) {
  const content = readFileSync(resolve(root, file), "utf-8");
  const match = content.match(pattern);
  if (!match) {
    console.error(`  FAIL  ${file} — expected pattern ${pattern} not found (was the text rephrased?)`);
    failures++;
    continue;
  }
  const found = Number(match[1]);
  if (found !== expected) {
    console.error(
      `  FAIL  ${file}: found ${found} ${label}, expected ${expected}`,
    );
    failures++;
  } else {
    console.log(`  OK    ${file}: ${found} ${label}`);
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} file(s) have stale stablecoin counts. Update them to match CANONICAL_ORDER (${trackedCount}) / SHADOW_STABLECOINS (${shadowCount}).`,
  );
  process.exit(1);
}

console.log("\nAll stablecoin counts are in sync.");
