#!/usr/bin/env node
/**
 * CI guard: detects stale hardcoded counts in primary docs.
 * Reads authoritative counts from source files, then checks key docs
 * for matching numbers.
 *
 * Covered counts:
 *   - Tracked stablecoins (CANONICAL_ORDER)
 *   - Shadow stablecoins (SHADOW_STABLECOINS)
 *   - Reserve adapters (ADAPTERS record)
 *   - Bluechip slugs (BLUECHIP_SLUG_MAP)
 *   - Live-enabled stablecoins (liveReservesConfig declarations)
 *
 * Usage: node scripts/check-doc-counts.mjs
 * Exits 0 if all counts match, 1 if any are stale.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// --- Extract authoritative counts from source ---

// 1. Tracked stablecoins
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

// 2. Shadow stablecoins
const shadowSrc = readFileSync(
  resolve(root, "shared/lib/shadow-stablecoins.ts"),
  "utf-8",
);
const shadowCount = (shadowSrc.match(/\{\s*id:\s*"/g) || []).length;

const psiCount = trackedCount + shadowCount;

// 3. Reserve adapters
const adapterSrc = readFileSync(
  resolve(root, "worker/src/cron/reserve-adapters/index.ts"),
  "utf-8",
);
const adapterBlock = adapterSrc.match(
  /const ADAPTERS:\s*Record<[\s\S]*?>\s*=\s*\{([\s\S]*?)\};/,
);
if (!adapterBlock) {
  console.error("FATAL: Could not find ADAPTERS record in reserve-adapters/index.ts");
  process.exit(1);
}
const adapterCount = (adapterBlock[1].match(/^\s+(?:"[a-z][a-z0-9-]+"|\w+)\s*:/gm) || []).length;

// 4. Bluechip slugs
const bluechipSrc = readFileSync(
  resolve(root, "worker/src/lib/bluechip-slugs.ts"),
  "utf-8",
);
const bluechipBlock = bluechipSrc.match(
  /BLUECHIP_SLUG_MAP:\s*Record<[\s\S]*?>\s*=\s*\{([\s\S]*?)\};/,
);
if (!bluechipBlock) {
  console.error("FATAL: Could not find BLUECHIP_SLUG_MAP in bluechip-slugs.ts");
  process.exit(1);
}
const bluechipCount = (bluechipBlock[1].match(/^\s+\w+:\s*"/gm) || []).length;

// 5. Live-enabled stablecoins (coins declaring liveReservesConfig across stablecoin metadata files)
const stablecoinDir = resolve(root, "shared/lib/stablecoins");
const coinFiles = readdirSync(stablecoinDir)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts" && f !== "factory.ts")
  .map((f) => resolve(stablecoinDir, f));
const liveEnabledCount = coinFiles.reduce(
  (sum, f) =>
    sum + (readFileSync(f, "utf-8").match(/liveReservesConfig:\s*\{/g) || []).length,
  0,
);

console.log(
  `Authoritative counts: ${trackedCount} tracked, ${shadowCount} shadow, ${psiCount} PSI-eligible, ${adapterCount} adapters, ${bluechipCount} bluechip slugs, ${liveEnabledCount} live-enabled`,
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

  // Reserve adapter counts
  {
    file: "docs/live-reserves.md",
    pattern: /across (\d+) registered adapters/,
    expected: adapterCount,
    label: "adapters",
  },
  {
    file: "docs/architecture.md",
    pattern: /reserve adapters \((\d+) adapters\)/,
    expected: adapterCount,
    label: "adapters",
  },

  // Bluechip slug counts
  {
    file: "docs/worker-infrastructure.md",
    pattern: /from bluechip\.org for (\d+) tracked/,
    expected: bluechipCount,
    label: "bluechip slugs",
  },
  {
    file: "docs/worker-infrastructure.md",
    pattern: /all (\d+) slugs in/,
    expected: bluechipCount,
    label: "bluechip slugs",
  },
  {
    file: "docs/worker-infrastructure.md",
    pattern: /ID mapping \((\d+) coins\)/,
    expected: bluechipCount,
    label: "bluechip slugs",
  },
  {
    file: "docs/bluechip-ratings.md",
    pattern: /contains (\d+) Bluechip slugs/,
    expected: bluechipCount,
    label: "bluechip slugs",
  },
  {
    file: "docs/bluechip-ratings.md",
    pattern: /(\d+) slug mappings/,
    expected: bluechipCount,
    label: "bluechip slugs",
  },

  // Live-enabled stablecoin count
  {
    file: "docs/live-reserves.md",
    pattern: /(\d+) live-enabled stablecoins/,
    expected: liveEnabledCount,
    label: "live-enabled",
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
    `\n${failures} check(s) failed. Update docs to match source:` +
    `\n  CANONICAL_ORDER=${trackedCount}, SHADOW=${shadowCount}, PSI=${psiCount}` +
    `\n  ADAPTERS=${adapterCount}, BLUECHIP_SLUG_MAP=${bluechipCount}, LIVE_ENABLED=${liveEnabledCount}`,
  );
  process.exit(1);
}

console.log("\nAll doc counts are in sync.");
