#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "fs";
import { extname, dirname, join, relative, resolve } from "path";
import ts from "typescript";

const ROOT = process.cwd();
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
]);
const EXPORT_ALLOWLIST = new Set([
  // Identity markers consumed by worker/src/__mocks__/__tests__/vitest-aliases.test.ts via vitest path aliases (not visible to static analysis).
  "worker/src/__mocks__/satori-stub.ts::__stub",
  "worker/src/__mocks__/wasm-module-stub.ts::__stub",
  "worker/src/__mocks__/resvg-stub.ts::__stub",
  "shared/lib/api-endpoints/index.ts::buildQueryPath",
  "shared/lib/api-endpoints/index.ts::getStrictContractPaths",
  "shared/lib/api-endpoints/index.ts::DynamicAdminEndpointMatch",
  "shared/lib/api-endpoints/index.ts::EndpointMethodValidationError",
  "shared/lib/api-endpoints/index.ts::EndpointProbeGroup",
  "shared/lib/api-endpoints/index.ts::EndpointPublicApiAccess",
  "shared/lib/api-endpoints/index.ts::EndpointSiteDataAccess",
  "shared/lib/chain-health-version.ts::getChainHealthMethodologyVersionAt",
  "shared/lib/chains.ts::CHAIN_RESILIENCE_TIER",
  // Backward-compatible type export for callers that imported the old lib path.
  "shared/lib/cause-of-death.ts::CauseOfDeath",
  "shared/lib/mint-burn-signals.ts::COIN_FLOW_COMPOSITE_STATE_VALUES",
  "shared/lib/mint-burn-signals.ts::PRESSURE_SHIFT_STABLE_BAND_MAX",
  "shared/lib/pricing-pipeline-version.ts::PRICING_PIPELINE_VERSION",
  "shared/lib/pricing-pipeline-version.ts::getPricingPipelineVersionAt",
  "shared/lib/redemption-backstop-scoring.ts::REDEMPTION_EXECUTION_LABELS",
  "shared/lib/redemption-backstop-version.ts::getRedemptionBackstopVersionAt",
  "shared/lib/report-cards.ts::chainInfraLabel",
  "shared/lib/report-cards.ts::inferResilienceDefaults",
  // Explicit no-op yield-risk scaffold kept public for the staged report-card integration.
  "shared/lib/report-cards.ts::resolveReportCardYieldRiskAdjustment",
  "shared/lib/report-cards.ts::ReportCardYieldRiskAdjustment",
  "shared/lib/report-cards.ts::ReportCardYieldRiskNoOpReason",
  "shared/lib/safety-score-version.ts::getSafetyScoreVersionAt",
  "shared/lib/stablecoin-id-registry.ts::ALL_LIVE_COINS",
  "shared/lib/stablecoins/schema.ts::StablecoinMetaAssetSchema",
  "shared/lib/stablecoins/schema.ts::StablecoinMetaAssetArraySchema",
  "shared/lib/stablecoins/schema.ts::CanonicalOrderAssetSchema",
  "shared/lib/stablecoins/schema.ts::DeadStablecoinAssetSchema",
  "shared/lib/stablecoins/schema.ts::DeadStablecoinAssetArraySchema",
  // Consumed by scripts/lib/stablecoin-catalog-sources.ts (out-of-scan-scope).
  "shared/lib/stablecoins/schema.ts::findDuplicateStablecoinCatalogIds",
  "shared/lib/tracked-stablecoin-utils.ts::findTrackedContract",
  "shared/lib/yield-scoring.ts::PYS_DEFAULT_SAFETY_SCORE",
  "src/components/pharos-logo.tsx::PharosLogoWithText",
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
  "src/components/ui/table.tsx::TableFooter",
  "src/hooks/use-api-query.ts::createApiQueryFnWithMeta",
  "src/hooks/use-preferences.ts::isColumnId",
  "src/lib/compare-config.ts::ID_TO_COMPARE_COIN",
  // Consumed by scripts/check-frozen-invariants.ts (out-of-scan-scope).
  "src/lib/compare-pages.ts::STATIC_COMPARE_PAIRS",
  // Consumed by scripts/check-cron-connection-budget.ts (out-of-scan-scope).
  "shared/lib/cron-jobs.ts::CRON_CONNECTION_BUDGET",
  "shared/lib/cron-jobs.ts::CRON_CONNECTION_BUDGET_ENTRIES",
  "src/lib/coverage.ts::resolveSafetyCoverage",
  "src/lib/coverage.ts::resolveYieldCoverage",
  "src/lib/coverage.ts::resolveBlacklistCoverage",
  "src/lib/coverage.ts::resolveDependencyCoverage",
  "src/lib/coverage.ts::countAvailableFeatures",
  "src/lib/coverage/blacklist.ts::formatBlacklistBreakdown",
  "src/lib/coverage/blacklist.ts::BLACKLIST_STATUS_KINDS",
  "src/lib/coverage/blacklist.ts::BLACKLIST_LEGEND_ITEMS",
  "src/lib/coverage/dependency.ts::formatDependencyBreakdown",
  "src/lib/coverage/dependency.ts::DEPENDENCY_STATUS_KINDS",
  "src/lib/coverage/dependency.ts::DEPENDENCY_LEGEND_ITEMS",
  "src/lib/coverage/dex.ts::formatDexBreakdown",
  "src/lib/coverage/dex.ts::DEX_STATUS_KINDS",
  "src/lib/coverage/dex.ts::DEX_LEGEND_ITEMS",
  "src/lib/coverage/flows.ts::formatFlowsBreakdown",
  "src/lib/coverage/flows.ts::FLOWS_STATUS_KINDS",
  "src/lib/coverage/flows.ts::FLOWS_LEGEND_ITEMS",
  "src/lib/coverage/price.ts::formatPriceBreakdown",
  "src/lib/coverage/price.ts::PRICE_STATUS_KINDS",
  "src/lib/coverage/price.ts::PRICE_LEGEND_ITEMS",
  "src/lib/coverage/redemption.ts::formatRedemptionBreakdown",
  "src/lib/coverage/redemption.ts::REDEMPTION_STATUS_KINDS",
  "src/lib/coverage/redemption.ts::REDEMPTION_LEGEND_ITEMS",
  "src/lib/coverage/reserves.ts::formatReservesBreakdown",
  "src/lib/coverage/reserves.ts::RESERVES_STATUS_KINDS",
  "src/lib/coverage/reserves.ts::RESERVES_LEGEND_ITEMS",
  "src/lib/coverage/safety.ts::formatSafetyBreakdown",
  "src/lib/coverage/safety.ts::SAFETY_STATUS_KINDS",
  "src/lib/coverage/safety.ts::SAFETY_LEGEND_ITEMS",
  "src/lib/coverage/yield.ts::formatYieldBreakdown",
  "src/lib/coverage/yield.ts::YIELD_STATUS_KINDS",
  "src/lib/coverage/yield.ts::YIELD_LEGEND_ITEMS",
  "src/lib/stablecoin-detail-view-model.ts::buildMarketSnapshot",
  "src/lib/stablecoin-detail-view-model.ts::buildPegPriceSnapshot",
  "src/lib/stablecoin-detail-view-model.ts::buildFeatureAvailability",
  "src/lib/stablecoin-detail-view-model.ts::buildStaleQueryInputs",
  "src/lib/start-here-callout.ts::START_HERE_CALLOUT_STORAGE_KEY",
  "src/lib/start-here-callout.ts::MAX_START_HERE_HOMEPAGE_SESSIONS",
  "src/lib/status-dashboard-model.ts::getTopCauses",
  "src/lib/yield-constants.ts::WARNING_SIGNAL_LABELS",
  "worker/src/api/mint-burn-flows-shared.ts::FLOW_CACHE_PREFIX",
  "worker/src/api/mint-burn-flows-shared.ts::readCachedFlow",
  // Thin admin handler wrappers kept for direct test/script compatibility.
  "worker/src/api/api-key-requests/admin-handlers.ts::handleApiKeyRequestReleaseClaim",
  "worker/src/api/api-keys.ts::handleApiKeyDeactivate",
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
  "worker/src/cron/dex-liquidity/fetch-crawlers.ts::fetchCgPools",
  "worker/src/cron/dex-liquidity/fetch-crawlers.ts::fetchGtPools",
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
  "worker/src/cron/telegram-pending-queue.ts::PENDING_TTL_SEC",
  "worker/src/lib/chain-registry.ts::CG_CHAIN_REVERSE",
  "worker/src/lib/chain-registry.ts::GT_CHAIN_REVERSE",
  "worker/src/lib/coingecko-onchain.ts::CG_CHAIN_REVERSE",
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
  "worker/src/lib/schemas.ts::CronMetadataSchema",
  "worker/src/lib/stability-index.ts::BAND_COLORS",
  "worker/src/__mocks__/resvg-stub.ts::Resvg",
  "worker/src/__mocks__/resvg-stub.ts::initWasm",
  "worker/src/__mocks__/resvg-stub.ts::initResvg",
  "worker/src/__mocks__/resvg-stub.ts::resvgWasmModule",
  "worker/src/__mocks__/satori-stub.ts::init",
  "worker/src/__mocks__/satori-stub.ts::satori",
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

if (process.argv.includes("--audit-allowlist")) {
  const stale = [];
  for (const entry of EXPORT_ALLOWLIST) {
    const [file] = entry.split("::");
    try {
      statSync(file);
    } catch {
      stale.push({ entry, reason: "file does not exist" });
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
  const results = [];
  for (const dir of SOURCE_DIRS) {
    walk(resolve(ROOT, dir), results);
  }
  return results.sort();
}

function walk(dir, results) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "out") continue;
      walk(full, results);
      continue;
    }
    if (full.endsWith(".d.ts")) continue;
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue;
    results.push(full);
  }
}

function analyzeModule(file) {
  const sourceText = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(file),
  );

  const exports = new Set();
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
  return { exports, dependencies, hasWildcardExports, hasSideEffectsOnly };
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

function getScriptKind(file) {
  const extension = extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".ts" || extension === ".mts") return ts.ScriptKind.TS;
  if (extension === ".mjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.JS;
}

function visit(node, callback) {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}
