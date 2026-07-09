#!/usr/bin/env node

import { statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { collectSourceFilesUnderRoot } from "../lib/source-files.mjs";
import { parseSourceFile } from "../lib/ts-ast.mjs";

const ROOT = process.cwd();
const AUDIT_ALLOWLIST = !process.argv.includes("--skip-allowlist-audit");
const SOURCE_DIRS = ["src", "shared", "worker/src", "functions"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs"]);
const REPORTABLE_DIR_PREFIXES = ["src/", "shared/", "worker/src/", "functions/"];
const UNUSED_EXPORT_DIR_PREFIXES = ["src/", "shared/", "worker/src/", "functions/"];

const ROOT_ENTRYPOINT_PATTERNS = [
  /^src\/app\//,
  /^functions\//,
  /^worker\/src\/index\.ts$/,
  /^worker\/src\/handlers\/scheduled\.ts$/,
];

const MODULE_ALLOWLIST = new Set([
  "src/components/ui/command.tsx",
  "worker/src/__mocks__/resvg-stub.ts",
  "worker/src/__mocks__/satori-stub.ts",
  "worker/src/__mocks__/wasm-module-stub.ts",
  // Public compatibility shim; current label consumers use the light constants
  // module so they do not pull methodology body data into client bundles.
  "shared/lib/mint-authority-version.ts",
  // refreshing-bar.tsx + use-row-cursor.ts are now consumed by the power-user
  // tables (Wave 9: stablecoin-table, screener-table, depeg-tracker-table).
  // Filter summary helpers; per-tracker adoption deferred. (command-palette-verbs.ts
  // is now consumed by src/components/command-palette.tsx.)
]);
const EXPORT_ALLOWLIST = new Set([
  // Identity markers consumed by worker/src/__mocks__/__tests__/vitest-aliases.test.ts via vitest path aliases (not visible to static analysis).
  "worker/src/__mocks__/satori-stub.ts::__stub",
  "worker/src/__mocks__/wasm-module-stub.ts::__stub",
  "worker/src/__mocks__/resvg-stub.ts::__stub",
  // Intra-cluster sibling-module exports surfaced after Phase 4 Wave 3 decompositions —
  // each export IS consumed by a sibling file in the same folder but the static scan
  // doesn't reach sibling consumption. Allowlist rather than drop because each is
  // genuinely consumed within its cluster.
  "worker/src/cron/dews/source-state/fallback.ts::isBootstrapAllowedMissingTableSource",
  "worker/src/cron/dews/source-state/hydration.ts::DEWS_STALE_DEX_LIQUIDITY_SEC",
  "worker/src/cron/dews/source-state/hydration.ts::DEWS_PREVIOUS_SIGNAL_SMOOTHING_MAX_AGE_SEC",
  "worker/src/cron/dews/source-state/legacy-bridge.ts::getNumber",
  "worker/src/cron/sync-stablecoins/supplemental-assets/shared.ts::buildSupplementalAsset",
  "worker/src/cron/yield-sync/cache.ts::YieldRankingsPublishedCutoffResult",
  "worker/src/cron/yield-sync/cache.ts::ParsedYieldSupplementalSourcesCache",
  "worker/src/cron/yield-sync/cache/normalization.ts::toNullableString",
  "worker/src/cron/yield-sync/cache/normalization.ts::toStringArray",
  "worker/src/lib/dews/evidence-policy.ts::EVIDENCE_STRESS_THRESHOLD",
  "worker/src/lib/dews/evidence-policy.ts::hasStressEvidence",
  "worker/src/lib/redemption-backstop-capacity.ts::CapacityResolution",
  // Consumed at build time by scripts/build-data/build-client-registry.mjs as
  // the canonical field allowlist; the validator reads the array at runtime
  // outside the TS import graph the static scan walks.
  "shared/types/stablecoin-client-meta.ts::STABLECOIN_CLIENT_META_FIELDS",
  "shared/types/stablecoin-client-meta.ts::GENIUS_CLIENT_PROFILE_FIELDS",
  "shared/types/stablecoin-client-meta.ts::GENIUS_COMPLIANCE_PROFILE_FIELDS",
  "shared/lib/api-endpoints/index.ts::buildQueryPath",
  "shared/lib/api-endpoints/index.ts::DynamicAdminEndpointMatch",
  "shared/lib/api-endpoints/index.ts::EndpointMethodValidationError",
  "shared/lib/api-endpoints/index.ts::EndpointProbeGroup",
  "shared/lib/api-endpoints/index.ts::EndpointPublicApiAccess",
  "shared/lib/api-endpoints/index.ts::EndpointSiteDataAccess",
  "shared/lib/chains/health-version.ts::getChainHealthMethodologyVersionAt",
  "shared/lib/chains/index.ts::CHAIN_RESILIENCE_TIER",
  // L2BEAT snapshot/audit helpers are consumed by advisory scripts and kept as
  // an explicit methodology surface even when not imported by runtime pages.
  "shared/lib/chains/l2beat-audit.ts::findL2BeatAliasIntegrityIssues",
  "shared/lib/chains/l2beat-interop.ts::getL2BeatInteropProtocol",
  "shared/lib/chains/l2beat-risk.ts::L2BEAT_STAGE_SCORES",
  "shared/lib/chains/l2beat-risk.ts::L2BEAT_RISK_SENTIMENT_SCORES",
  "shared/lib/chains/l2beat-risk.ts::L2BEAT_STAGE_WEIGHT",
  "shared/lib/chains/l2beat-risk.ts::L2BEAT_RISK_WEIGHT",
  // Backward-compatible type export for callers that imported the old lib path.
  "shared/lib/cause-of-death.ts::CauseOfDeath",
  // Consumed by scripts/lib/methodology-to-markdown.ts for checked-in markdown
  // export generation outside this runtime source graph.
  "shared/lib/methodology-versions/registry.ts::METHODOLOGY_CHANGELOG_MARKDOWN_KEYS",
  "shared/lib/methodology-versions/registry.ts::getMethodologyChangelogEntryByMarkdownKey",
  "shared/lib/mint-burn-signals.ts::COIN_FLOW_COMPOSITE_STATE_VALUES",
  "shared/lib/mint-burn-signals.ts::PRESSURE_SHIFT_STABLE_BAND_MAX",
  "shared/lib/pricing-pipeline-version.ts::PRICING_PIPELINE_VERSION",
  "shared/lib/pricing-pipeline-version.ts::getPricingPipelineVersionAt",
  "shared/lib/redemption-backstop-scoring.ts::REDEMPTION_EXECUTION_LABELS",
  // Consumed by scripts/lib/redemption-backstop-validation.ts (out-of-scan-scope).
  "shared/lib/redemption-backstop-configs/factory.ts::getBackstopRegistrySourceFilePaths",
  "shared/lib/redemption-backstop-configs/policies.ts::REDEMPTION_BACKSTOP_POLICY_ENTRIES",
  "shared/lib/redemption-backstop-version.ts::getRedemptionBackstopVersionAt",
  // Safety Score methodology constants are imported by calibration/advisory
  // scripts outside this runtime-only scan and are kept public for review work.
  "shared/lib/report-cards.ts::BRIDGE_ROUTE_RISK_BLEND_WEIGHT",
  "shared/lib/report-cards.ts::BRIDGE_ROUTE_RISK_LABEL",
  "shared/lib/report-cards.ts::BRIDGE_ROUTE_RISK_SCORE",
  "shared/lib/report-cards.ts::ORACLE_RISK_BLEND_WEIGHT",
  "shared/lib/report-cards.ts::ORACLE_RISK_LABEL",
  "shared/lib/report-cards.ts::isOracleRiskApplicable",
  "shared/lib/report-cards.ts::chainInfraLabel",
  "shared/lib/report-cards.ts::inferResilienceDefaults",
  // Consumed by scripts/ci/check-site-csp-sync.ts and static-export tooling
  // outside the runtime source graph scanned by this checker.
  "shared/lib/site-csp.ts::buildStaticContentSecurityPolicy",
  "shared/lib/safety-score-version.ts::getSafetyScoreVersionAt",
  "shared/lib/stablecoin-id-registry.ts::ALL_LIVE_COINS",
  "shared/lib/stablecoins/schema.ts::StablecoinMetaAssetSchema",
  "shared/lib/stablecoins/schema.ts::StablecoinMetaAssetArraySchema",
  "shared/lib/stablecoins/schema.ts::CanonicalOrderAssetSchema",
  "shared/lib/stablecoins/schema.ts::DeadStablecoinAssetSchema",
  "shared/lib/stablecoins/schema.ts::DeadStablecoinAssetArraySchema",
  // Consumed by scripts/lib/stablecoin-catalog-sources.ts for per-coin
  // catalog field ordering and domain sidecar validation.
  "shared/lib/stablecoins/schema.ts::STABLECOIN_META_ASSET_FIELD_ORDER",
  "shared/lib/stablecoins/schema.ts::STABLECOIN_SOURCE_DOMAIN_VALUES",
  "shared/lib/stablecoins/schema.ts::StablecoinReservesSidecarSchema",
  "shared/lib/stablecoins/schema.ts::StablecoinMetaSourceAssetSchema",
  "shared/lib/stablecoins/schema.ts::STABLECOIN_SOURCE_DOMAIN_FIELDS",
  "shared/lib/stablecoins/schema.ts::STABLECOIN_SOURCE_DOMAIN_SCHEMAS",
  "shared/types/stablecoin-meta-schemas.ts::OracleRiskBranchSchema",
  "shared/types/stablecoin-meta-schemas.ts::BridgeRouteProtocolEvidenceSchema",
  // Consumed by scripts/lib/stablecoin-catalog-sources.ts (out-of-scan-scope).
  "shared/lib/stablecoins/schema.ts::findDuplicateStablecoinCatalogIds",
  "shared/lib/tracked-stablecoin-utils.ts::findTrackedContract",
  "shared/lib/yield-scoring.ts::PYS_DEFAULT_SAFETY_SCORE",
  "src/components/providers.tsx::ToastContext",
  "src/components/providers.tsx::useToastContext",
  "src/components/ui/badge.tsx::badgeVariants",
  "src/components/ui/button.tsx::buttonVariants",
  "src/components/ui/card.tsx::CardFooter",
  "src/components/ui/command.tsx::Command",
  "src/components/ui/command.tsx::CommandDialog",
  "src/components/ui/command.tsx::CommandList",
  "src/components/ui/command.tsx::CommandEmpty",
  "src/components/ui/command.tsx::CommandGroup",
  "src/components/ui/command.tsx::CommandItem",
  "src/components/ui/command.tsx::CommandInput",
  "src/components/ui/command.tsx::CommandShortcut",
  "src/components/ui/command.tsx::CommandSeparator",
  "src/components/ui/dialog.tsx::DialogClose",
  "src/components/ui/dialog.tsx::DialogOverlay",
  "src/components/ui/dialog.tsx::DialogPortal",
  "src/components/ui/dropdown-menu.tsx::DropdownMenuPortal",
  "src/components/ui/dropdown-menu.tsx::DropdownMenuGroup",
  "src/components/ui/dropdown-menu.tsx::DropdownMenuRadioGroup",
  "src/components/ui/dropdown-menu.tsx::DropdownMenuRadioItem",
  "src/components/ui/dropdown-menu.tsx::DropdownMenuShortcut",
  "src/components/ui/dropdown-menu.tsx::DropdownMenuSub",
  "src/components/ui/dropdown-menu.tsx::DropdownMenuSubTrigger",
  "src/components/ui/dropdown-menu.tsx::DropdownMenuSubContent",
  "src/components/ui/sheet.tsx::SheetClose",
  "src/components/ui/sheet.tsx::SheetFooter",
  "src/hooks/use-api-query.ts::createApiQueryFnWithMeta",
  "src/hooks/use-preferences.ts::isColumnId",
  "src/lib/compare-config.ts::ID_TO_COMPARE_COIN",
  // Consumed by scripts/ci/check-frozen-invariants.ts (out-of-scan-scope).
  "src/lib/compare-pages.ts::STATIC_COMPARE_PAIRS",
  // Consumed by scripts/maintenance/generate-homepage-bootstrap.ts for static
  // bootstrap payload generation outside this runtime source graph.
  "src/lib/homepage-bootstrap.ts::HomepageBootstrapQueryId",
  // Consumed by scripts/ci/check-cron-connection-budget.ts (out-of-scan-scope).
  "shared/lib/cron-jobs.ts::CRON_CONNECTION_BUDGET",
  "shared/lib/cron-jobs.ts::CRON_CONNECTION_BUDGET_ENTRIES",
  // Consumed by scripts/ci/check-cron-schedule-sync.ts (out-of-scan-scope).
  "shared/lib/scheduled-runner-registry.ts::SCHEDULED_SLOT_PLANS",
  "shared/lib/scheduled-runner-registry.ts::flattenScheduledSlotPlanJobs",
  "shared/lib/scheduled-runner-registry.ts::getScheduledSlotPlanBudgetEntries",
  "src/lib/coverage.ts::countAvailableFeatures",
  "src/lib/yield-constants.ts::WARNING_SIGNAL_LABELS",
  // Storage key + snapshot reader exported for tests and one-off lookups
  // (e.g. compare-config presets). External consumption is intermittent.
  "src/hooks/use-watchlist.ts::WATCHLIST_STORAGE_KEY",
  "src/hooks/use-watchlist.ts::readWatchlistSnapshot",
  // Consumed internally by buildAllCoinTrackerLinks; the static scan does not
  // resolve same-file references.
  "src/lib/coin-tracker-links.ts::buildCoinTrackerLink",
  // parsePaletteInput + buildCompareHrefFromCoinIds are consumed by
  // src/components/command-palette.tsx. resolveCoinIdFromToken is only consumed
  // internally by parsePaletteInput; the static scan does not resolve same-file
  // references, so it stays allowlisted.
  "src/lib/command-palette-verbs.ts::resolveCoinIdFromToken",
  "worker/src/api/mint-burn-flows-shared.ts::FLOW_CACHE_PREFIX",
  "worker/src/api/mint-burn-flows-shared.ts::readCachedFlow",
  "worker/src/api/telegram-webhook-messages.ts::describeSubscriptionSettings",
  "worker/src/api/telegram-webhook-messages.ts::describeGlobalAlertSettings",
  "worker/src/api/telegram-webhook-messages.ts::formatCoinLines",
  "worker/src/api/telegram-webhook-messages.ts::buildMiniAppOnlyKeyboard",
  "worker/src/api/telegram-webhook-parsing.ts::parseStoredSetCommand",
  "worker/src/api/telegram-webhook-parsing.ts::parseStringArray",
  "worker/src/api/telegram-webhook-parsing.ts::parseResolvedCoins",
  "worker/src/api/telegram-webhook-resolution.ts::resolveCoinTargets",
  "worker/src/cron/blacklist/evm-source.ts::parseEvmLogs",
  "worker/src/cron/blacklist/evm-source.ts::resolveRpcLogTarget",
  "worker/src/cron/dex-liquidity/challenger-persistence.ts::detectDexPriceChallengerTableState",
  "worker/src/cron/dex-liquidity/challenger-persistence.ts::selectDexPriceChallengerRowsFromPools",
  "worker/src/cron/dex-liquidity/geckoterminal-shared.ts::getGtPoolKind",
  "worker/src/cron/dex-liquidity/pool-identity.ts::buildKnownPoolIdentityIndex",
  "worker/src/cron/dex-liquidity/token-resolution.ts::normalizeTokenAddress",
  "worker/src/cron/dex-liquidity/token-resolution.ts::resolveStablecoinToken",
  "worker/src/cron/reserve-adapters/helpers.ts::isHttpHtmlInput",
  "worker/src/cron/reserve-adapters/helpers.ts::fetchErc20TotalSupply",
  "worker/src/cron/sync-stablecoins/metadata.ts::buildPriceSourceHealth",
  "worker/src/cron/sync-stablecoins/shared.ts::sumPegBuckets",
  "worker/src/cron/telegram-alert-snapshots.ts::SNAPSHOT_MAX_AGE_SEC",
  "worker/src/cron/telegram-alert-snapshots.ts::SAFETY_GRADE_RANK",
  "worker/src/lib/chain-registry.ts::CG_CHAIN_REVERSE",
  "worker/src/lib/chain-registry.ts::GT_CHAIN_REVERSE",
  "worker/src/lib/cron-lease.ts::isRetriableD1OverloadError",
  "worker/src/lib/dex-api-common.ts::DIRECT_API_MAX_POOL_TVL_USD",
  "worker/src/lib/external-api-schemas.ts::TronEventResultSchema",
  "worker/src/lib/external-api-schemas.ts::TronEventSchema",
  "shared/lib/env-contract.ts::ENV_BINDINGS",
  "shared/lib/env-contract.ts::getAllEnvBindingKeys",
  "worker/src/lib/live-reserves-store.ts::getConfiguredLiveReserveCoins",
  "worker/src/lib/live-reserves-store.ts::upsertReserveComposition",
  "worker/src/lib/mint-burn-health-config.ts::computeMintBurnSyncFreshnessStatus",
  "worker/src/lib/mint-burn-scoring.ts::MIN_ACTIVITY_USD",
  // Provider execution wrappers are the staged transport facade for later
  // provider migrations; DEX direct APIs currently consume providerJson while
  // the fetch/text variants remain available for the next fetch-heavy surfaces.
  "worker/src/lib/provider-execution.ts::providerFetch",
  "worker/src/lib/provider-execution.ts::providerTextBounded",
  "worker/src/lib/schemas.ts::CronMetadataSchema",
  "worker/src/lib/stability-index.ts::BAND_COLORS",
  "worker/src/__mocks__/resvg-stub.ts::Resvg",
  "worker/src/__mocks__/resvg-stub.ts::initWasm",
  "worker/src/__mocks__/resvg-stub.ts::initResvg",
  "worker/src/__mocks__/resvg-stub.ts::resvgWasmModule",
  "worker/src/__mocks__/satori-stub.ts::init",
  "worker/src/__mocks__/satori-stub.ts::satori",
  // Consumed only by test files (live-reserve-adapters-schemas.test.ts); the
  // static scan counts test imports as usage but the CI unused-code guard does
  // not, so it must be allowlisted explicitly. Keep exported until a production
  // reserve-adapter config adopts this wider staleness window.
  "shared/lib/live-reserve-adapters-schemas.ts::LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC",
  // Public/script/test helper surfaces intentionally kept exported even when no
  // runtime source currently imports them.
  "shared/lib/api-endpoints/datasets.ts::PUBLIC_DATASET_TOPICS",
  "shared/lib/redemption-backstop-configs/schema.ts::currentUtcDate",
  "src/components/command-palette-model.ts::scoreStablecoinSearchMatch",
  "src/components/command-palette-model.ts::isExactStablecoinSymbolMatch",
  "src/components/command-palette-model.ts::stablecoinProminenceBonus",
  "src/components/chart-primitives/data-table.tsx::capDataForTable",
  "src/components/table/table-label.ts::withFallbackTableAriaLabel",
  "src/components/table/table-label.ts::hasTableCaptionChild",
  "src/lib/alt-peg-packing.ts::DEFAULT_COLLISION_ITERATIONS",
  "src/lib/api-key-request-admin-view-model.ts::REQUEST_RISK_FLAG_SCORE",
  "src/lib/api.ts::normalizeApiDependencyMeta",
  "src/lib/exports/csv.ts::escapeCsvField",
  "src/lib/exports/csv.ts::buildCsv",
  "src/lib/homepage-bootstrap-shared.ts::descriptorMaxAgeMs",
  "src/lib/yield-data-source.ts::YIELD_DATA_SOURCE_META",
  "worker/src/api/dex-liquidity-evidence.ts::isTrendworthyLiquiditySnapshot",
  "worker/src/api/telegram-webhook-pending-gate.ts::canActOnPendingOwner",
  "worker/src/cron/daily-digest/voice-guards.ts::FORBIDDEN_TICS_ANYWHERE",
  "worker/src/cron/daily-digest/voice-guards.ts::FORBIDDEN_TICS_CLOSER",
  "worker/src/cron/reserve-adapters/slice-math.ts::RATIO_SCALE",
  "worker/src/lib/fx-rate-state.ts::resetFxRateStateForTests",
  "worker/src/lib/psi-history-universe.ts::buildPsiHistoricalUniverseForDay",
  "worker/src/cron/yield-sync/cache.ts::parseRiskFreeRatesCache",
  "worker/src/cron/yield-sync/cache.ts::filterValidDlPools",
]);

const files = collectSourceFiles();
const fileSet = new Set(files);
const moduleInfo = new Map(
  files.map((file) => [file, analyzeModule(file)]),
);

const runtimeInbound = new Map(files.map((file) => [file, new Set()]));
const namedExportUsage = new Map(files.map((file) => [file, new Set()]));
const ambiguousUsage = new Set();

for (const [file, info] of moduleInfo.entries()) {
  for (const dependency of info.dependencies) {
    if (!runtimeInbound.has(dependency.resolved)) continue;
    runtimeInbound.get(dependency.resolved).add(file);
    if (dependency.kind !== "named") {
      ambiguousUsage.add(dependency.resolved);
      continue;
    }
    const usedNames = namedExportUsage.get(dependency.resolved);
    for (const name of dependency.names) {
      usedNames.add(name);
    }
  }
}

const deadModules = [];
const unusedExports = [];

for (const file of files) {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  const info = moduleInfo.get(file);
  if (!isReportableModule(rel) || isTestFile(rel) || isRootEntrypoint(rel)) continue;

  if ((runtimeInbound.get(file)?.size ?? 0) === 0 && !MODULE_ALLOWLIST.has(rel)) {
    deadModules.push({
      file: rel,
      reason: info.exports.size === 0 && info.hasSideEffectsOnly ? "unreferenced module" : "unreferenced module or dead shim",
    });
    continue;
  }

  if (!isUnusedExportReportable(rel) || ambiguousUsage.has(file) || info.hasWildcardExports) continue;

  const usedNames = namedExportUsage.get(file) ?? new Set();
  for (const name of info.exports) {
    const exportKey = `${rel}::${name}`;
    if (usedNames.has(name) || EXPORT_ALLOWLIST.has(exportKey)) continue;
    unusedExports.push({ file: rel, name });
  }
}

if (deadModules.length > 0) {
  console.error("Dead internal modules:");
  for (const moduleEntry of deadModules) {
    console.error(`  ${moduleEntry.file} (${moduleEntry.reason})`);
  }
}

if (unusedExports.length > 0) {
  console.error("Unused named exports:");
  for (const item of unusedExports) {
    console.error(`  ${item.file} :: ${item.name}`);
  }
}

if (AUDIT_ALLOWLIST) {
  const stale = [];
  for (const entry of EXPORT_ALLOWLIST) {
    const [file, symbol] = entry.split("::");
    try {
      statSync(file);
    } catch {
      stale.push({ entry, reason: "file does not exist" });
      continue;
    }
    // Beyond file existence, verify the allowlisted symbol is still exported.
    // A renamed/deleted export would otherwise pass this audit silently and
    // keep masking a now-nonexistent symbol. Wildcard re-exports (`export *`)
    // can surface a symbol the static export set doesn't list, so skip those.
    const info = analyzeModule(resolve(ROOT, file));
    if (!info.hasWildcardExports && !info.exports.has(symbol) && !info.typeExports.has(symbol)) {
      stale.push({ entry, reason: "symbol no longer exported from file" });
    }
  }
  for (const mod of MODULE_ALLOWLIST) {
    try {
      statSync(mod);
    } catch {
      stale.push({ entry: mod, reason: "module does not exist" });
    }
  }
  if (stale.length > 0) {
    process.stderr.write("\nStale allowlist entries:\n");
    for (const s of stale) {
      process.stderr.write(`  ${s.entry} — ${s.reason}\n`);
    }
    process.stderr.write(`\n${stale.length} stale entry/entries.\n`);
    process.exit(1);
  }
  process.stdout.write("Allowlist audit: all entries valid.\n");
}

if (deadModules.length === 0 && unusedExports.length === 0) {
  console.log("No dead internal modules or unused named exports found.");
  process.exit(0);
}

process.exit(1);

function collectSourceFiles() {
  const excludedDirs = new Set(["node_modules", ".next", "out"]);
  const results = SOURCE_DIRS.flatMap((dir) =>
    collectSourceFilesUnderRoot(dir, ROOT, { extensions: SOURCE_EXTENSIONS, excludedDirs })
      .filter((f) => !f.endsWith(".d.ts")),
  );
  return results.sort();
}

function analyzeModule(file) {
  const { sourceFile } = parseSourceFile(file);

  const exports = new Set();
  // Fully type-only export declarations (`export type { X }` / `export type { X } from`)
  // are intentionally excluded from `exports` (they are never runtime-dead), but the
  // allowlist audit still needs to know they exist so it doesn't false-flag a valid
  // type-only allowlist entry as a stale symbol.
  const typeExports = new Set();
  const dependencies = [];
  let hasWildcardExports = false;
  let hasSideEffectsOnly = true;

  for (const node of sourceFile.statements) {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      hasExportModifier(node) ||
      ts.isExportAssignment(node)
    ) {
      hasSideEffectsOnly = false;
    }
  }

  visit(sourceFile, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const resolved = resolveModule(file, node.moduleSpecifier.text);
      if (resolved) {
        dependencies.push(...collectImportDependencies(node, resolved));
      }
    }

    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const resolved = resolveModule(file, node.moduleSpecifier.text);
        if (resolved) {
          dependencies.push(
            node.exportClause && ts.isNamedExports(node.exportClause)
              ? {
                  resolved,
                  kind: "named",
                  names: node.exportClause.elements.map((element) => element.propertyName?.text ?? element.name.text),
                }
              : { resolved, kind: "namespace", names: [] },
          );
        }
      }

      if (node.isTypeOnly) {
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) {
            typeExports.add(element.name.text);
          }
        }
        return;
      }

      if (!node.exportClause) {
        hasWildcardExports = true;
      } else if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          exports.add(element.name.text);
        }
      }
    }

    if (ts.isExportAssignment(node)) {
      exports.add("default");
    }

    if (hasExportModifier(node)) {
      collectExportedNames(node, exports);
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const resolved = resolveModule(file, node.arguments[0].text);
      if (resolved) {
        dependencies.push({ resolved, kind: "side-effect", names: [] });
      }
    }
  });

  exports.delete("default");
  return { exports, typeExports, dependencies, hasWildcardExports, hasSideEffectsOnly };
}

function collectImportDependencies(node, resolved) {
  const deps = [];
  const importClause = node.importClause;
  if (!importClause) {
    deps.push({ resolved, kind: "side-effect", names: [] });
    return deps;
  }

  if (importClause.name) {
    deps.push({ resolved, kind: "default", names: [] });
  }

  const bindings = importClause.namedBindings;
  if (!bindings) return deps;

  if (ts.isNamespaceImport(bindings)) {
    deps.push({ resolved, kind: "namespace", names: [] });
    return deps;
  }

  deps.push({
    resolved,
    kind: "named",
    names: bindings.elements.map((element) => element.propertyName?.text ?? element.name.text),
  });
  return deps;
}

function collectExportedNames(node, exports) {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    if (node.name) exports.add(node.name.text);
    return;
  }

  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      collectBindingNames(declaration.name, exports);
    }
  }
}

function collectBindingNames(name, exports) {
  if (ts.isIdentifier(name)) {
    exports.add(name.text);
    return;
  }

  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      collectBindingNames(element.name, exports);
    }
  }
}

function hasExportModifier(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function resolveModule(fromFile, specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/") && !specifier.startsWith("@shared/")) {
    return null;
  }

  let candidate;
  if (specifier.startsWith("@/")) {
    candidate = resolve(ROOT, "src", specifier.slice(2));
  } else if (specifier.startsWith("@shared/")) {
    candidate = resolve(ROOT, "shared", specifier.slice("@shared/".length));
  } else {
    candidate = resolve(dirname(fromFile), specifier);
  }

  const resolved = resolveWithExtensions(candidate);
  return resolved && fileSet.has(resolved) ? resolved : null;
}

function resolveWithExtensions(basePath) {
  const directStat = tryStat(basePath);
  if (directStat?.isFile()) return basePath;

  for (const extension of SOURCE_EXTENSIONS) {
    const withExtension = `${basePath}${extension}`;
    if (tryStat(withExtension)?.isFile()) return withExtension;
  }

  for (const extension of SOURCE_EXTENSIONS) {
    const asIndex = join(basePath, `index${extension}`);
    if (tryStat(asIndex)?.isFile()) return asIndex;
  }

  return null;
}

function tryStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function isReportableModule(relPath) {
  return REPORTABLE_DIR_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function isUnusedExportReportable(relPath) {
  return UNUSED_EXPORT_DIR_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function isRootEntrypoint(relPath) {
  return ROOT_ENTRYPOINT_PATTERNS.some((pattern) => pattern.test(relPath));
}

function isTestFile(relPath) {
  return relPath.includes("/__tests__/") || /\.test\.[^/]+$/.test(relPath) || /\.spec\.[^/]+$/.test(relPath);
}

function visit(node, callback) {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}
