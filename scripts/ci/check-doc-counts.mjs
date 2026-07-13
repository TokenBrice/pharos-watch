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
 *   - Reserve adapter bindings and per-adapter configured-coin counts
 *   - Blacklist tracker contract configs, chains, and tracked symbols
 *   - Bluechip slugs (BLUECHIP_SLUG_MAP)
 *   - Live-enabled stablecoins (liveReservesConfig declarations)
 *   - Mint/burn contract configs, unique stablecoin IDs, and lane counts
 *   - DEX provider-inaccessible deployments, active coins, and owned waivers
 *   - MiCA assessed/unassessed status counts
 *   - Status-tracked cron jobs and scheduled trigger expressions
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

function extractMintBurnContractCounts() {
  const sourcePath = resolve(root, "worker/src/lib/mint-burn-contracts-data.ts");
  const { sourceFile } = parseSourceFile(sourcePath);
  const mainInitializer = findVariableInitializer(sourceFile, "MINT_BURN_CONFIG_SPECS");
  const expansionInitializer = findVariableInitializer(sourceFile, "EXTENDED_ETHEREUM_TRANSFER_EXPANSION_SPECS");
  if (!mainInitializer || !ts.isArrayLiteralExpression(mainInitializer)) {
    throw new Error("FATAL: Could not find MINT_BURN_CONFIG_SPECS array");
  }
  if (!expansionInitializer || !ts.isArrayLiteralExpression(expansionInitializer)) {
    throw new Error("FATAL: Could not find EXTENDED_ETHEREUM_TRANSFER_EXPANSION_SPECS array");
  }

  const stablecoinIds = new Set();
  let configCount = 0;
  let criticalCount = 0;
  let extendedCount = 0;

  function addObjectConfig(element, defaultTier) {
    if (!ts.isObjectLiteralExpression(element)) {
      throw new Error("FATAL: Mint/burn config array contains a non-object element");
    }
    const stablecoinId = getObjectPropertyValue(element, "stablecoinId");
    if (!stablecoinId || !ts.isStringLiteral(stablecoinId)) {
      throw new Error("FATAL: Mint/burn config entry missing string stablecoinId");
    }
    const tierNode = getObjectPropertyValue(element, "tier");
    const tier = tierNode && ts.isStringLiteral(tierNode) ? tierNode.text : defaultTier;
    if (tier !== "critical" && tier !== "extended") {
      throw new Error(`FATAL: Unexpected mint/burn tier for ${stablecoinId.text}`);
    }

    stablecoinIds.add(stablecoinId.text);
    configCount++;
    if (tier === "critical") criticalCount++;
    else extendedCount++;
  }

  for (const element of mainInitializer.elements) {
    if (ts.isObjectLiteralExpression(element)) {
      addObjectConfig(element, "critical");
      continue;
    }
    if (
      ts.isSpreadElement(element) &&
      ts.isCallExpression(element.expression) &&
      ts.isPropertyAccessExpression(element.expression.expression) &&
      ts.isIdentifier(element.expression.expression.expression) &&
      element.expression.expression.expression.text === "EXTENDED_ETHEREUM_TRANSFER_EXPANSION_SPECS" &&
      element.expression.expression.name.text === "map"
    ) {
      for (const expansion of expansionInitializer.elements) {
        addObjectConfig(expansion, "extended");
      }
      continue;
    }
    throw new Error("FATAL: MINT_BURN_CONFIG_SPECS contains an unsupported expression");
  }

  return {
    configCount,
    stablecoinCount: stablecoinIds.size,
    criticalCount,
    extendedCount,
  };
}

const [
  stablecoinsModule,
  psiEligibleModule,
  shadowStablecoinsModule,
  reserveAdaptersModule,
  cronJobsModule,
  scheduledRunnerRegistryModule,
  bluechipSlugsModule,
  deadStablecoinsModule,
  dexDeploymentCoverageModule,
] = await Promise.all([
  import("../../shared/lib/stablecoins/registry.ts"),
  import("../../shared/lib/psi-eligible.ts"),
  import("../../shared/lib/shadow-stablecoins.ts"),
  import("../../shared/lib/live-reserve-adapters-definitions.ts"),
  import("../../shared/lib/cron-jobs.ts"),
  import("../../shared/lib/scheduled-runner-registry.ts"),
  import("../../shared/lib/bluechip-slugs.ts"),
  import("../../shared/lib/dead-stablecoins.ts"),
  import("../../shared/lib/dex-deployment-coverage.ts"),
]);

const TRACKED_STABLECOINS = getModuleExport(stablecoinsModule, "TRACKED_STABLECOINS");
const ACTIVE_STABLECOINS = getModuleExport(stablecoinsModule, "ACTIVE_STABLECOINS");
const PRE_LAUNCH_STABLECOINS = getModuleExport(stablecoinsModule, "PRE_LAUNCH_STABLECOINS");
const PSI_ELIGIBLE_STABLECOINS = getModuleExport(psiEligibleModule, "PSI_ELIGIBLE_STABLECOINS");
const SHADOW_STABLECOINS = getModuleExport(shadowStablecoinsModule, "SHADOW_STABLECOINS");
const LIVE_RESERVE_ADAPTER_DEFINITIONS = getModuleExport(reserveAdaptersModule, "LIVE_RESERVE_ADAPTER_DEFINITIONS");
const CRON_JOB_DEFINITIONS = getModuleExport(cronJobsModule, "CRON_JOB_DEFINITIONS");
const SCHEDULED_SLOT_PLANS = getModuleExport(scheduledRunnerRegistryModule, "SCHEDULED_SLOT_PLANS");
const BLUECHIP_SLUG_MAP = getModuleExport(bluechipSlugsModule, "BLUECHIP_SLUG_MAP");
const DEAD_STABLECOINS = getModuleExport(deadStablecoinsModule, "DEAD_STABLECOINS");
const DEX_COVERAGE_WAIVERS = getModuleExport(dexDeploymentCoverageModule, "DEX_COVERAGE_WAIVERS");
const getDexDiscoveryProviders = getModuleExport(dexDeploymentCoverageModule, "getDexDiscoveryProviders");
const FROZEN_STABLECOINS = getModuleExport(stablecoinsModule, "FROZEN_STABLECOINS");
const blacklistContractCounts = extractBlacklistContractCounts();
const mintBurnContractCounts = extractMintBurnContractCounts();

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
const trackedLiveReserveAdapterCounts = new Map();
for (const coin of TRACKED_STABLECOINS) {
  const adapter = coin.liveReservesConfig?.adapter;
  if (adapter) {
    trackedLiveReserveAdapterCounts.set(adapter, (trackedLiveReserveAdapterCounts.get(adapter) ?? 0) + 1);
  }
}
const activeLiveReserveAdapterKeys = new Set(
  ACTIVE_STABLECOINS.flatMap((coin) => coin.liveReservesConfig?.adapter ?? []),
);
const trackedLiveReserveAdapterKeys = new Set(trackedLiveReserveAdapterCounts.keys());
const unboundLiveReserveAdapters = Object.entries(LIVE_RESERVE_ADAPTER_DEFINITIONS)
  .filter(([key]) => !trackedLiveReserveAdapterKeys.has(key))
  .map(([key, definition]) => [key, definition.provenance.status])
  .sort(([a], [b]) => a.localeCompare(b));

// 6. Mint/burn contract coverage
const mintBurnConfigCount = mintBurnContractCounts.configCount;
const mintBurnStablecoinCount = mintBurnContractCounts.stablecoinCount;
const mintBurnCriticalCount = mintBurnContractCounts.criticalCount;
const mintBurnExtendedCount = mintBurnContractCounts.extendedCount;

// 7. DEX deployment coverage
const providerInaccessibleDeployments = ACTIVE_STABLECOINS.flatMap((coin) =>
  [...(coin.contracts ?? []), ...(coin.tradedContracts ?? [])]
    .filter((deployment) => getDexDiscoveryProviders(deployment.chain).length === 0)
    .map((deployment) => ({ stablecoinId: coin.id, chain: deployment.chain, address: deployment.address })),
);
const providerInaccessibleDeploymentCount = providerInaccessibleDeployments.length;
const providerInaccessibleStablecoinCount = new Set(
  providerInaccessibleDeployments.map((deployment) => deployment.stablecoinId),
).size;
const dexCoverageWaiverCount = DEX_COVERAGE_WAIVERS.length;

// 8. MiCA metadata coverage. TRACKED_STABLECOINS includes migrated compliance sidecars.
const micaStatusCounts = new Map();
for (const coin of TRACKED_STABLECOINS) {
  if (coin.mica) {
    micaStatusCounts.set(coin.mica.status, (micaStatusCounts.get(coin.mica.status) ?? 0) + 1);
  }
}
const micaAssessedCount = [...micaStatusCounts.values()].reduce((sum, count) => sum + count, 0);
const micaUnassessedCount = trackedCount - micaAssessedCount;

// 9. Scheduled runtime inventory
const statusTrackedCronJobCount = CRON_JOB_DEFINITIONS.length;
const jobBearingScheduleExpressionCount = new Set(CRON_JOB_DEFINITIONS.map((definition) => definition.schedule)).size;
const totalTriggerExpressionCount = new Set(Object.values(SCHEDULED_SLOT_PLANS).map((plan) => plan.schedule)).size;

// 10. Cemetery / dead-stablecoins.json count (used in report-cards.md)
const cemeteryCount = DEAD_STABLECOINS.length;
// Report-cards "snapshot size" = active scored + cemetery entries + frozen archive (pre-launch excluded).
// buildDefunctReportCards emits stub F-cards for both DEAD_STABLECOINS and FROZEN_STABLECOINS.
const reportCardSnapshotCount = activeCount + cemeteryCount + frozenCount;

// Printed only on failure: success output stays one line so agent sessions
// running this via merge-gate/doc tasks don't re-read 30 lines per run.
const authoritativeCounts = `Authoritative counts: ${trackedCount} tracked (${activeCount} active + ${preLaunchCount} pre-launch + ${frozenCount} frozen), ${shadowCount} shadow, ${psiCount} PSI-eligible (${psiActiveTrackedCount} active tracked + ${shadowCount} shadow), ${adapterCount} adapters (${trackedLiveReserveAdapterKeys.size} configured, ${unboundLiveReserveAdapters.length} unbound), ${bluechipCount} bluechip slugs, ${blacklistContractCounts.configCount} blacklist contract configs / ${blacklistContractCounts.chainCount} chains / ${blacklistContractCounts.stablecoinCount} tracked symbols, ${activeLiveEnabledCount} active live-enabled / ${trackedLiveReserveConfigCount} tracked live-reserve configs, ${mintBurnConfigCount} mint/burn configs / ${mintBurnStablecoinCount} IDs (${mintBurnCriticalCount} critical + ${mintBurnExtendedCount} extended), ${providerInaccessibleDeploymentCount} provider-inaccessible DEX deployments / ${providerInaccessibleStablecoinCount} active coins / ${dexCoverageWaiverCount} waivers, ${micaAssessedCount} MiCA assessed / ${micaUnassessedCount} unassessed, ${statusTrackedCronJobCount} cron jobs / ${jobBearingScheduleExpressionCount} job-bearing expressions / ${totalTriggerExpressionCount} total trigger expressions, ${cemeteryCount} cemetery, ${reportCardSnapshotCount} report-card snapshot`;

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
    optional: true,
  },
  {
    file: "docs/bluechip-ratings.md",
    pattern: /(\d+) slug mappings/,
    expected: bluechipCount,
    label: "bluechip slugs",
    optional: true,
  },

  // Live-enabled stablecoin count
  {
    file: "docs/live-reserves.md",
    pattern: /(\d+) active live-enabled stablecoins/,
    expected: activeLiveEnabledCount,
    label: "active live-enabled",
  },
  {
    file: "docs/live-reserves.md",
    pattern: /(\d+) tracked metadata entries have live reserve configs/,
    expected: trackedLiveReserveConfigCount,
    label: "tracked live-reserve configs",
  },
  {
    file: "docs/live-reserves.md",
    pattern: /Both the active and tracked config sets use (\d+) adapter keys/,
    expected: trackedLiveReserveAdapterKeys.size,
    label: "configured live-reserve adapter keys",
  },
  {
    file: "docs/live-reserves.md",
    pattern: /the other (\d+) registered keys are explicitly unbound/,
    expected: unboundLiveReserveAdapters.length,
    label: "unbound live-reserve adapters",
  },

  // Mint/burn coverage counts
  {
    file: "docs/mint-burn-flows.md",
    pattern: /Current scope: \*\*(\d+) contract configs\*\*/,
    expected: mintBurnConfigCount,
    label: "mint/burn contract configs",
  },
  {
    file: "docs/mint-burn-flows.md",
    pattern: /across \*\*(\d+) stablecoin IDs\*\*/,
    expected: mintBurnStablecoinCount,
    label: "mint/burn stablecoin IDs",
  },
  {
    file: "docs/mint-burn-flows.md",
    pattern: /\((\d+) implicit critical \+ \d+ extended\)/,
    expected: mintBurnCriticalCount,
    label: "mint/burn critical configs",
  },
  {
    file: "docs/mint-burn-flows.md",
    pattern: /\(\d+ implicit critical \+ (\d+) extended\)/,
    expected: mintBurnExtendedCount,
    label: "mint/burn extended configs",
  },
  {
    file: "docs/depeg-resolver.md",
    pattern: /mint\/burn coverage exists for (\d+) of \d+ tracked coins/,
    expected: mintBurnStablecoinCount,
    label: "DDR mint/burn-covered stablecoins",
  },
  {
    file: "docs/depeg-resolver.md",
    pattern: /mint\/burn coverage exists for \d+ of (\d+) tracked coins/,
    expected: trackedCount,
    label: "DDR tracked stablecoins",
  },
  {
    file: "docs/depeg-resolver.md",
    pattern: /\((\d+) contract configs across the configured issuance chains\)/,
    expected: mintBurnConfigCount,
    label: "DDR mint/burn contract configs",
  },

  // DEX provider coverage
  {
    file: "docs/dex-liquidity.md",
    pattern: /all (\d+) provider-inaccessible deployments across \d+ active coins/,
    expected: providerInaccessibleDeploymentCount,
    label: "provider-inaccessible DEX deployments",
  },
  {
    file: "docs/dex-liquidity.md",
    pattern: /provider-inaccessible deployments across (\d+) active coins/,
    expected: providerInaccessibleStablecoinCount,
    label: "provider-inaccessible active coins",
  },
  {
    file: "docs/dex-liquidity.md",
    pattern: /the (\d+) coins whose entire deployment footprint is inaccessible have owned waivers/,
    expected: dexCoverageWaiverCount,
    label: "DEX coverage waivers",
  },

  // Optional because this volatile narrative may be removed instead of maintained.
  {
    file: "docs/mica-tracker.md",
    pattern: /\b(Forty|\d+) tracked coins currently carry structured `mica` metadata/,
    expected: micaAssessedCount,
    label: "MiCA assessed",
    optional: true,
    parse: (value) => (value === "Forty" ? 40 : Number(value)),
  },
  {
    file: "docs/mica-tracker.md",
    pattern: /(\d+) `authorized`/,
    expected: micaStatusCounts.get("authorized") ?? 0,
    label: "MiCA authorized",
    optional: true,
  },
  {
    file: "docs/mica-tracker.md",
    pattern: /(\d+) `non-compliant`/,
    expected: micaStatusCounts.get("non-compliant") ?? 0,
    label: "MiCA non-compliant",
    optional: true,
  },
  {
    file: "docs/mica-tracker.md",
    pattern: /(\d+) `pending`/,
    expected: micaStatusCounts.get("pending") ?? 0,
    label: "MiCA pending",
    optional: true,
  },
  {
    file: "docs/mica-tracker.md",
    pattern: /(\d+) `out-of-scope`/,
    expected: micaStatusCounts.get("out-of-scope") ?? 0,
    label: "MiCA out-of-scope",
    optional: true,
  },
  {
    file: "docs/mica-tracker.md",
    pattern: /The other (\d+) tracked coins are unassessed/,
    expected: micaUnassessedCount,
    label: "MiCA unassessed",
    optional: true,
  },

  // Optional because these volatile inventory summaries may be removed instead of maintained.
  {
    file: "docs/architecture.md",
    pattern: /Connection budgets cover (\d+) jobs across \d+ job-bearing schedule expressions/,
    expected: statusTrackedCronJobCount,
    label: "status-tracked cron jobs",
    optional: true,
  },
  {
    file: "docs/architecture.md",
    pattern: /Connection budgets cover \d+ jobs across (\d+) job-bearing schedule expressions/,
    expected: jobBearingScheduleExpressionCount,
    label: "job-bearing schedule expressions",
    optional: true,
  },
  {
    file: "docs/architecture.md",
    pattern: /brings the deployed total to (\d+)/,
    expected: totalTriggerExpressionCount,
    label: "total trigger expressions",
    optional: true,
  },
  {
    file: "docs/worker-infrastructure.md",
    pattern: /scheduled runtime work across (\d+) cron expressions/,
    expected: totalTriggerExpressionCount,
    label: "total trigger expressions",
    optional: true,
  },
  {
    file: "docs/worker-infrastructure.md",
    pattern: /track the (\d+) `CRON_JOB_DEFINITIONS` jobs across \d+ job-bearing expressions/,
    expected: statusTrackedCronJobCount,
    label: "status-tracked cron jobs",
    optional: true,
  },
  {
    file: "docs/worker-infrastructure.md",
    pattern: /track the \d+ `CRON_JOB_DEFINITIONS` jobs across (\d+) job-bearing expressions/,
    expected: jobBearingScheduleExpressionCount,
    label: "job-bearing schedule expressions",
    optional: true,
  },
  {
    file: "docs/worker-infrastructure.md",
    pattern: /worker declares (\d+) cron expressions/,
    expected: totalTriggerExpressionCount,
    label: "total trigger expressions",
    optional: true,
  },
  {
    file: "docs/worker-infrastructure.md",
    pattern: /Tracks (\d+) cron jobs across \d+ job-bearing schedule expressions/,
    expected: statusTrackedCronJobCount,
    label: "status-tracked cron jobs",
    optional: true,
  },
  {
    file: "docs/worker-infrastructure.md",
    pattern: /Tracks \d+ cron jobs across (\d+) job-bearing schedule expressions/,
    expected: jobBearingScheduleExpressionCount,
    label: "job-bearing schedule expressions",
    optional: true,
  },
];

let failures = 0;

for (const { file, pattern, expected, label, optional = false, parse = Number } of CHECKS) {
  const content = readFileSync(resolve(root, file), "utf-8");
  const match = content.match(pattern);
  if (!match) {
    if (optional) continue;
    console.error(`  FAIL  ${file} — expected pattern ${pattern} not found (was the text rephrased?)`);
    failures++;
    continue;
  }
  const found = parse(match[1]);
  if (found !== expected) {
    console.error(`  FAIL  ${file}: found ${found} ${label}, expected ${expected}`);
    failures++;
  }
}

if (activeLiveReserveAdapterKeys.size !== trackedLiveReserveAdapterKeys.size) {
  console.error(
    `  FAIL  docs/live-reserves.md: active and tracked configs use different adapter-key counts ` +
      `(${activeLiveReserveAdapterKeys.size} active vs ${trackedLiveReserveAdapterKeys.size} tracked); describe them separately`,
  );
  failures++;
}

const liveReserveDoc = readFileSync(resolve(root, "docs/live-reserves.md"), "utf-8");
const documentedLiveReserveAdapterCounts = new Map(
  [...liveReserveDoc.matchAll(/^\| `([^`]+)`[^\n]*\|\s+(\d+)\s+\|$/gm)].map(([, key, count]) => [
    key,
    Number(count),
  ]),
);
for (const key of Object.keys(LIVE_RESERVE_ADAPTER_DEFINITIONS)) {
  const documentedCount = documentedLiveReserveAdapterCounts.get(key);
  const expected = trackedLiveReserveAdapterCounts.get(key) ?? 0;
  if (documentedCount === undefined) {
    console.error(`  FAIL  docs/live-reserves.md — adapter inventory row missing for ${key}`);
    failures++;
  } else if (documentedCount !== expected) {
    console.error(
      `  FAIL  docs/live-reserves.md: ${key} has ${documentedCount} configured coins, expected ${expected}`,
    );
    failures++;
  }
}

const unboundSection = liveReserveDoc.match(
  /Current unbound registered adapters are explicit:\n\n([\s\S]*?)\n\n`parked` and `retired` descriptors/,
)?.[1];
if (!unboundSection) {
  console.error("  FAIL  docs/live-reserves.md — unbound registered adapter table not found");
  failures++;
} else {
  const documentedUnbound = [...unboundSection.matchAll(/^\| `([^`]+)`\s+\| `([^`]+)`/gm)]
    .map(([, key, status]) => [key, status])
    .sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(documentedUnbound) !== JSON.stringify(unboundLiveReserveAdapters)) {
    console.error(
      `  FAIL  docs/live-reserves.md: unbound adapter rows ${JSON.stringify(documentedUnbound)}, ` +
        `expected ${JSON.stringify(unboundLiveReserveAdapters)}`,
    );
    failures++;
  }
}

if (failures > 0) {
  console.error(authoritativeCounts);
  console.error(
    `\n${failures} check(s) failed. Update docs to match source:` +
      `\n  CANONICAL_ORDER=${trackedCount}, SHADOW=${shadowCount}, PSI=${psiCount}` +
      `\n  ADAPTERS=${adapterCount}, CONFIGURED_ADAPTER_KEYS=${trackedLiveReserveAdapterKeys.size}, UNBOUND_ADAPTERS=${unboundLiveReserveAdapters.length}, BLUECHIP_SLUG_MAP=${bluechipCount}, BLACKLIST_CONFIGS=${blacklistContractCounts.configCount}, BLACKLIST_CHAINS=${blacklistContractCounts.chainCount}, BLACKLIST_SYMBOLS=${blacklistContractCounts.stablecoinCount}, ACTIVE_LIVE_ENABLED=${activeLiveEnabledCount}, TRACKED_LIVE_RESERVE_CONFIGS=${trackedLiveReserveConfigCount}, MINT_BURN_CONFIGS=${mintBurnConfigCount}, MINT_BURN_IDS=${mintBurnStablecoinCount}, DEX_INACCESSIBLE_DEPLOYMENTS=${providerInaccessibleDeploymentCount}, DEX_INACCESSIBLE_COINS=${providerInaccessibleStablecoinCount}, DEX_COVERAGE_WAIVERS=${dexCoverageWaiverCount}, MICA_ASSESSED=${micaAssessedCount}, MICA_UNASSESSED=${micaUnassessedCount}, CRON_JOBS=${statusTrackedCronJobCount}, JOB_BEARING_EXPRESSIONS=${jobBearingScheduleExpressionCount}, TOTAL_TRIGGER_EXPRESSIONS=${totalTriggerExpressionCount}`,
  );
  process.exit(1);
}

console.log(`Doc counts: all ${CHECKS.length} checks in sync.`);
