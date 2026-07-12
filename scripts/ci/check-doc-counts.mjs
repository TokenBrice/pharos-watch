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
 *   - Blacklist tracker contract configs, chains, and tracked symbols
 *   - Bluechip slugs (BLUECHIP_SLUG_MAP)
 *   - Live-enabled stablecoins (liveReservesConfig declarations)
 *   - Cemetery entries (DEAD_STABLECOINS)
 *
 * Usage: node scripts/ci/check-doc-counts.mjs
 * Exits 0 if all counts match, 1 if any are stale.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import "tsx";
import { parseSourceFile } from "../lib/ts-ast.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");

// --- Extract authoritative counts from source ---

function getModuleExport(module, name) {
  const value = module[name] ?? module.default?.[name] ?? module["module.exports"]?.[name];
  if (value == null) {
    throw new Error(`FATAL: Could not import ${name}`);
  }
  return value;
}

function findVariableInitializer(sourceFile, variableName) {
  let initializer = null;
  function visit(node) {
    if (initializer) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variableName) {
      initializer = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return initializer;
}

function getObjectPropertyValue(objectLiteral, propertyName) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
    if (key === propertyName) {
      return property.initializer;
    }
  }
  return null;
}

function extractBlacklistContractCounts() {
  const sourcePath = resolve(root, "worker/src/lib/blacklist-contracts.ts");
  const { sourceFile } = parseSourceFile(sourcePath);
  const initializer = findVariableInitializer(sourceFile, "CONTRACT_CONFIG_SPECS");
  if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
    throw new Error("FATAL: Could not find CONTRACT_CONFIG_SPECS array");
  }

  const stablecoinIds = new Set();
  const chainIdentifiers = new Set();
  let configCount = 0;

  for (const element of initializer.elements) {
    if (!ts.isObjectLiteralExpression(element)) {
      throw new Error("FATAL: CONTRACT_CONFIG_SPECS contains a non-object element");
    }
    configCount++;

    const stablecoinId = getObjectPropertyValue(element, "stablecoinId");
    if (!stablecoinId || !ts.isStringLiteral(stablecoinId)) {
      throw new Error("FATAL: CONTRACT_CONFIG_SPECS entry missing string stablecoinId");
    }
    stablecoinIds.add(stablecoinId.text);

    const chain = getObjectPropertyValue(element, "chain");
    if (!chain || !ts.isIdentifier(chain)) {
      throw new Error("FATAL: CONTRACT_CONFIG_SPECS entry missing identifier chain");
    }
    chainIdentifiers.add(chain.text);
  }

  return {
    configCount,
    stablecoinCount: stablecoinIds.size,
    chainCount: chainIdentifiers.size,
  };
}

const [
  stablecoinsModule,
  psiEligibleModule,
  shadowStablecoinsModule,
  reserveAdaptersModule,
  bluechipSlugsModule,
  deadStablecoinsModule,
] = await Promise.all([
  import("../../shared/lib/stablecoins/registry.ts"),
  import("../../shared/lib/psi-eligible.ts"),
  import("../../shared/lib/shadow-stablecoins.ts"),
  import("../../shared/lib/live-reserve-adapters-definitions.ts"),
  import("../../shared/lib/bluechip-slugs.ts"),
  import("../../shared/lib/dead-stablecoins.ts"),
]);

const TRACKED_STABLECOINS = getModuleExport(stablecoinsModule, "TRACKED_STABLECOINS");
const ACTIVE_STABLECOINS = getModuleExport(stablecoinsModule, "ACTIVE_STABLECOINS");
const PRE_LAUNCH_STABLECOINS = getModuleExport(stablecoinsModule, "PRE_LAUNCH_STABLECOINS");
const PSI_ELIGIBLE_STABLECOINS = getModuleExport(psiEligibleModule, "PSI_ELIGIBLE_STABLECOINS");
const SHADOW_STABLECOINS = getModuleExport(shadowStablecoinsModule, "SHADOW_STABLECOINS");
const LIVE_RESERVE_ADAPTER_DEFINITIONS = getModuleExport(reserveAdaptersModule, "LIVE_RESERVE_ADAPTER_DEFINITIONS");
const BLUECHIP_SLUG_MAP = getModuleExport(bluechipSlugsModule, "BLUECHIP_SLUG_MAP");
const DEAD_STABLECOINS = getModuleExport(deadStablecoinsModule, "DEAD_STABLECOINS");
const FROZEN_STABLECOINS = getModuleExport(stablecoinsModule, "FROZEN_STABLECOINS");
const blacklistContractCounts = extractBlacklistContractCounts();

// 1. Tracked stablecoins
const trackedCount = TRACKED_STABLECOINS.length;
const activeCount = ACTIVE_STABLECOINS.length;
const preLaunchCount = PRE_LAUNCH_STABLECOINS.length;
const frozenCount = FROZEN_STABLECOINS.length;

// 2. Shadow stablecoins
const shadowCount = SHADOW_STABLECOINS.length;

const psiCount = PSI_ELIGIBLE_STABLECOINS.length;
const psiActiveTrackedCount = activeCount;

// 3. Reserve adapters
const adapterCount = Object.keys(LIVE_RESERVE_ADAPTER_DEFINITIONS).length;

// 4. Bluechip slugs
const bluechipCount = Object.keys(BLUECHIP_SLUG_MAP).length;

// 5. Live-enabled stablecoins
const trackedLiveReserveConfigCount = TRACKED_STABLECOINS.filter((coin) =>
  Object.hasOwn(coin, "liveReservesConfig"),
).length;
const activeLiveEnabledCount = ACTIVE_STABLECOINS.filter((coin) => Object.hasOwn(coin, "liveReservesConfig")).length;

// 6. Cemetery / dead-stablecoins.json count (used in report-cards.md)
const cemeteryCount = DEAD_STABLECOINS.length;
// Report-cards "snapshot size" = active scored + cemetery entries + frozen archive (pre-launch excluded).
// buildDefunctReportCards emits stub F-cards for both DEAD_STABLECOINS and FROZEN_STABLECOINS.
const reportCardSnapshotCount = activeCount + cemeteryCount + frozenCount;

// Printed only on failure: success output stays one line so agent sessions
// running this via merge-gate/doc tasks don't re-read 30 lines per run.
const authoritativeCounts = `Authoritative counts: ${trackedCount} tracked (${activeCount} active + ${preLaunchCount} pre-launch + ${frozenCount} frozen), ${shadowCount} shadow, ${psiCount} PSI-eligible (${psiActiveTrackedCount} active tracked + ${shadowCount} shadow), ${adapterCount} adapters, ${bluechipCount} bluechip slugs, ${blacklistContractCounts.configCount} blacklist contract configs / ${blacklistContractCounts.chainCount} chains / ${blacklistContractCounts.stablecoinCount} tracked symbols, ${activeLiveEnabledCount} active live-enabled / ${trackedLiveReserveConfigCount} tracked live-reserve configs, ${cemeteryCount} cemetery, ${reportCardSnapshotCount} report-card snapshot`;

// --- Check primary docs for stale counts ---

const CHECKS = [
  {
    file: "README.md",
    pattern: /tracking (\d+) stablecoins/,
    expected: trackedCount,
    label: "tracked",
  },
  {
    file: "docs/report-cards.md",
    pattern: /(\d+) tracked metadata entries/,
    expected: trackedCount,
    label: "tracked",
  },
  {
    file: "docs/agent-code-map.md",
    pattern: /canonical-order\.json` - (\d+) entries/,
    expected: trackedCount,
    label: "tracked",
  },
  {
    file: "docs/report-cards.md",
    pattern: /score the (\d+) active tracked assets/,
    expected: activeCount,
    label: "active",
  },
  {
    file: "docs/report-cards.md",
    pattern: /score the \d+ active tracked assets plus the (\d+) cemetery assets/,
    expected: cemeteryCount,
    label: "cemetery",
  },
  {
    file: "docs/report-cards.md",
    pattern: /snapshot size is (\d+) cards/,
    expected: reportCardSnapshotCount,
    label: "report-card snapshot",
  },
  {
    file: "docs/report-cards.md",
    pattern: /(\d+) cards \((\d+) active tracked assets plus (\d+) cemetery entries/,
    expected: reportCardSnapshotCount,
    label: "report-card snapshot",
  },
  {
    file: "README.md",
    pattern: /(\d+) active assets on public data surfaces/,
    expected: activeCount,
    label: "active",
  },
  {
    file: "README.md",
    pattern: /(\d+) pre-launch entries/,
    expected: preLaunchCount,
    label: "pre-launch",
  },
  {
    file: "README.md",
    pattern: /(\d+) curated dead stablecoins/,
    expected: cemeteryCount,
    label: "cemetery",
  },
  {
    file: "README.md",
    pattern: /on-chain tracking of (\d+) stablecoins/,
    expected: blacklistContractCounts.stablecoinCount,
    label: "blacklist tracked symbols",
  },
  {
    file: "docs/blacklist-tracker.md",
    pattern: /across (\d+) contract configurations/,
    expected: blacklistContractCounts.configCount,
    label: "blacklist contract configs",
  },
  {
    file: "docs/blacklist-tracker.md",
    pattern: /contract configurations on (\d+) chains/,
    expected: blacklistContractCounts.chainCount,
    label: "blacklist chains",
  },
  {
    file: "docs/blacklist-tracker.md",
    pattern: /\((\d+) tracked symbols;/,
    expected: blacklistContractCounts.stablecoinCount,
    label: "blacklist tracked symbols",
  },
  {
    file: "docs/supply-snapshot.md",
    pattern: /currently (\d+) entries/,
    expected: psiCount,
    label: "PSI-eligible",
  },
  {
    file: "docs/supply-snapshot.md",
    pattern: /(\d+) active tracked/,
    expected: psiActiveTrackedCount,
    label: "active tracked",
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
    pattern: /(\d+) active live-enabled stablecoins/,
    expected: activeLiveEnabledCount,
    label: "active live-enabled",
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
    console.error(`  FAIL  ${file}: found ${found} ${label}, expected ${expected}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(authoritativeCounts);
  console.error(
    `\n${failures} check(s) failed. Update docs to match source:` +
      `\n  CANONICAL_ORDER=${trackedCount}, SHADOW=${shadowCount}, PSI=${psiCount}` +
      `\n  ADAPTERS=${adapterCount}, BLUECHIP_SLUG_MAP=${bluechipCount}, BLACKLIST_CONFIGS=${blacklistContractCounts.configCount}, BLACKLIST_CHAINS=${blacklistContractCounts.chainCount}, BLACKLIST_SYMBOLS=${blacklistContractCounts.stablecoinCount}, ACTIVE_LIVE_ENABLED=${activeLiveEnabledCount}, TRACKED_LIVE_RESERVE_CONFIGS=${trackedLiveReserveConfigCount}`,
  );
  process.exit(1);
}

console.log(`Doc counts: all ${CHECKS.length} checks in sync.`);
