#!/usr/bin/env node
/**
 * CI guard: detects stale hardcoded counts in primary docs.
 * Imports authoritative counts from source modules, then checks key docs
 * for matching numbers.
 *
 * Covered counts:
 *   - Tracked stablecoins (CANONICAL_ORDER)
 *   - Shadow stablecoins (SHADOW_STABLECOINS)
 *   - Reserve adapters (LIVE_RESERVE_ADAPTER_DEFINITIONS)
 *   - Bluechip slugs (BLUECHIP_SLUG_MAP)
 *   - Live-enabled stablecoins (liveReservesConfig declarations)
 *
 * Usage: node scripts/check-doc-counts.mjs
 * Exits 0 if all counts match, 1 if any are stale.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "tsx";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// --- Extract authoritative counts from source ---

function getModuleExport(module, name) {
  const value = module[name] ?? module.default?.[name] ?? module["module.exports"]?.[name];
  if (value == null) {
    throw new Error(`FATAL: Could not import ${name}`);
  }
  return value;
}

const [
  stablecoinsModule,
  shadowStablecoinsModule,
  reserveAdaptersModule,
  bluechipSlugsModule,
] = await Promise.all([
  import("../shared/lib/stablecoins/index.ts"),
  import("../shared/lib/shadow-stablecoins.ts"),
  import("../shared/lib/live-reserve-adapters-definitions.ts"),
  import("../shared/lib/bluechip-slugs.ts"),
]);

const TRACKED_STABLECOINS = getModuleExport(stablecoinsModule, "TRACKED_STABLECOINS");
const SHADOW_STABLECOINS = getModuleExport(shadowStablecoinsModule, "SHADOW_STABLECOINS");
const LIVE_RESERVE_ADAPTER_DEFINITIONS = getModuleExport(
  reserveAdaptersModule,
  "LIVE_RESERVE_ADAPTER_DEFINITIONS",
);
const BLUECHIP_SLUG_MAP = getModuleExport(bluechipSlugsModule, "BLUECHIP_SLUG_MAP");

// 1. Tracked stablecoins
const trackedCount = TRACKED_STABLECOINS.length;

// 2. Shadow stablecoins
const shadowCount = SHADOW_STABLECOINS.length;

const psiCount = trackedCount + shadowCount;

// 3. Reserve adapters
const adapterCount = Object.keys(LIVE_RESERVE_ADAPTER_DEFINITIONS).length;

// 4. Bluechip slugs
const bluechipCount = Object.keys(BLUECHIP_SLUG_MAP).length;

// 5. Live-enabled stablecoins
const liveEnabledCount = TRACKED_STABLECOINS.filter(
  (coin) => Object.hasOwn(coin, "liveReservesConfig"),
).length;

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
