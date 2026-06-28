#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { collectSourceFiles, runAsCli } from "../lib/source-files.mjs";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const DEFAULT_ROOTS = ["worker/src/cron", "worker/src/lib"];
const EXCLUDED_DIRS = new Set(["__tests__", "__mocks__", "test-helpers"]);

const KNOWN_FETCH_BODY_TIMEOUT_DEBT = new Set([
  "worker/src/cron/digest/platform.ts::const response = await fetchWithRetry(::const errorText = response ? await response.text() : \"no response after retries\";",
  "worker/src/cron/pending-depeg-confirmation-evidence.ts::const offchainRes = await fetchWithRetry(::const parsed = DefiLlamaCoinsPriceSchema.safeParse(await offchainRes.json());",
  "worker/src/cron/pending-depeg-confirmation-evidence.ts::const offchainRes = await fetchWithRetry(::const parsed = CoinGeckoSimplePriceSchema.safeParse(await offchainRes.json());",
  "worker/src/cron/reserve-adapters/defillama.ts::const res = await fetchWithRetry(::const body = (await res.json()) as {",
  "worker/src/cron/sync-stablecoins/enrich-prices-cmc-pass.ts::const cmcRes = await fetchWithRetry(::cmcJson = await cmcRes.json();",
  "worker/src/cron/sync-stablecoins/enrich-prices-defillama-pass.ts::const res = await fetchWithRetry(::const prices = parseDefiLlamaPriceMap(await res.json());",
  "worker/src/cron/sync-stablecoins/enrich-prices-jupiter-pass.ts::const res = await fetchWithRetry(::const parsed = JupiterPriceResponseSchema.safeParse(await res.json());",
  "worker/src/cron/sync-stablecoins/enrich-prices-jupiter-pass.ts::const res = await fetchWithRetry(::const parsed = SolanaSlotResponseSchema.safeParse(await res.json());",
  "worker/src/cron/sync-stablecoins/supplemental-assets/silver.ts::const cgMarketsRes = await fetchWithRetry(::cgMarketsRaw = await cgMarketsRes.json();",
  "worker/src/cron/sync-stablecoins/supply-gap-reconciliation.ts::const response = await fetchWithRetry(::return (await response.json()) as Record<string, CoinGeckoCurrentMcapRow>;",
  "worker/src/cron/sync-stablecoins/supply-gap-reconciliation.ts::const response = await fetchWithRetry(::const payload = (await response.json()) as CoinGeckoRecentMarketChart;",
  "worker/src/cron/sync-stablecoins/supply-gap-reconciliation.ts::const response = await fetchWithRetry(::const payload = await response.json();",
  "worker/src/cron/sync-stablecoins/zephyr-zsd.ts::const res = await fetchWithRetry(::const payload = await res.json();",
  "worker/src/cron/tbill-sources/shared.ts::const res = await fetchWithRetry(url, {::return parse(await res.text());",
  "worker/src/cron/tbill-sources/six.ts::const res = await fetchWithRetry(SIX_OAUTH_TOKEN_URL, {::return parseSixOauthToken(await res.text());",
  "worker/src/cron/tbill-sources/six.ts::const res = await fetchWithRetry(SIX_OAUTH_TOKEN_URL, {::const body = await res.text();",
  "worker/src/cron/tbill-sources/six.ts::const res = await fetchWithRetry(SIX_REPORT_DOWNLOAD_URL, {::const body = await res.text();",
  "worker/src/cron/yield-sync/etherfuse-cetes.ts::const res = await fetchWithRetry(::return parseEtherfuseCetesStablebondPage(await res.text());",
  "worker/src/cron/yield-sync/royco-dawn.ts::const res = await fetchWithRetry(::const body = (await res.json()) as RoycoExploreResponse;",
  "worker/src/cron/yield-sync/sources-dl.ts::const res = await fetchWithRetry(DL_YIELDS_URL, {::const body = (await res.json()) as { data?: unknown };",
  "worker/src/cron/yield-sync/sources-optional-protocols-onchain.ts::const res = await fetchWithRetry(::const body = (await res.json()) as Record<string, { usd?: number }>;",
  "worker/src/cron/yield-sync/sources-optional-protocols-protocol-api.ts::const res = await fetchWithRetry(::const body = (await res.json()) as { success?: boolean; data?: unknown };",
  "worker/src/cron/yield-sync/sources-optional-protocols-protocol-api.ts::const res = await fetchWithRetry(::const body = (await res.json()) as { entity?: string; data?: HashnoteReport[] };",
  "worker/src/cron/yield-sync/sources-optional-protocols-protocol-api.ts::const res = await fetchWithRetry(::const body = (await res.json()) as ZephyrHistoricalReturns;",
  "worker/src/cron/yield-sync/sources-optional-protocols-supplemental.ts::const res = await fetchWithRetry(::const body = (await res.json()) as { data?: { vaults?: { items?: MorphoVaultItem[] } } };",
  "worker/src/cron/yield-sync/sources-optional-protocols-supplemental.ts::const res = await fetchWithRetry(url, {::const body = (await res.json()) as { total?: number; results?: PendleMarket[] };",
  "worker/src/cron/yield-sync/sources-optional-protocols-supplemental.ts::const res = await fetchWithRetry(::const body = (await res.json()) as { data?: { vaults?: KongVault[] } };",
  "worker/src/lib/address-price-providers/shared.ts::const response = await fetchWithRetry(::return { json: await response.json(), diagnostic };",
  "worker/src/lib/backfill-fx.ts::const res = await fetchWithRetry(::const raw = await res.json();",
  "worker/src/lib/backfill-fx.ts::let res = await fetchWithRetry(::const raw = await res.json();",
  "worker/src/lib/backfill-fx.ts::res = await fetchWithRetry(::const raw = await res.json();",
  "worker/src/lib/cex-orderbooks.ts::const response = await fetchWithRetry(::return response.json();",
  "worker/src/lib/cex-tickers.ts::const response = await fetchWithRetry(::return { payload: (await response.json()) as T, transportOk: true };",
  "worker/src/lib/cex-tickers.ts::const response = await fetchWithRetry(::const payload = (await response.json()) as unknown;",
  "worker/src/lib/cex-tickers.ts::const response = await fetchWithRetry(::const payload = (await response.json()) as { bid?: string; ask?: string; price?: string; time?: string };",
  "worker/src/lib/cg-ticker.ts::const res = await fetchWithRetry(::const data = (await res.json()) as CgTickerResponse;",
  "worker/src/lib/coingecko-onchain.ts::const res = await fetchWithRetry(url, {::const json = (await res.json()) as { data?: unknown };",
  "worker/src/lib/coingecko-simple-price.ts::const res = await fetchWithRetry(::const parsed = CoinGeckoSimplePriceSchema.safeParse(await res.json());",
  "worker/src/lib/dexscreener.ts::const res = await fetchWithRetry(url, {::const raw = await res.text();",
  "worker/src/lib/evm-logs.ts::const res = await fetchWithRetry(`${ETHERSCAN_V2_BASE}?${params}`, {::return res.json() as Promise<{ status: string; message: string; result: EtherscanLogEntry[] }>;",
  "worker/src/lib/evm-rpc.ts::const res = await fetchWithRetry(::const body = (await res.json()) as JsonRpcEnvelope<unknown>;",
  "worker/src/lib/evm-rpc.ts::const res = await fetchWithRetry(::const body = (await res.json()) as JsonRpcEnvelope<string>;",
  "worker/src/lib/fx-realtime.ts::const res = await fetchWithRetry(::const data = OpenExchangeRatesSchema.parse(await res.json());",
  "worker/src/lib/geckoterminal-price-probe.ts::const res = await fetchWithRetry(::const json = (await res.json()) as { data?: GtPool[] };",
  "worker/src/lib/native-peg-quotes.ts::const response = await fetchWithRetry(::const payload = await response.json();",
  "worker/src/lib/pyth.ts::const res = await fetchWithRetry(::const data = PythPriceFeedSchema.parse(await res.json());",
  "worker/src/lib/redstone.ts::const res = await fetchWithRetry(::const data = (await res.json()) as Record<string, RedstoneEntry | RedstoneEntry[]>;",
]);

function normalizeRelPath(path) {
  return path.replaceAll("\\", "/");
}

function collectScanFiles(cwd, roots) {
  const files = [];
  for (const root of roots) {
    const absoluteRoot = resolve(cwd, root);
    if (!existsSync(absoluteRoot)) continue;
    files.push(...collectSourceFiles(absoluteRoot, { extensions: SOURCE_EXTENSIONS, excludedDirs: EXCLUDED_DIRS }));
  }
  return files
    .filter((file) => SOURCE_EXTENSIONS.has(extname(file)))
    .map((file) => normalizeRelPath(relative(cwd, file)))
    .sort();
}

export function makeViolationKey(violation) {
  return `${violation.file}::${violation.assignmentText}::${violation.bodyReadText}`;
}

export function findFetchBodyTimeoutViolations(source, file = "<source>") {
  const lines = source.split(/\r?\n/g);
  const tracked = [];
  const violations = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    const declarationMatch = trimmed.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+fetchWithRetry\s*\(/);
    const assignmentMatch = declarationMatch
      ? null
      : trimmed.match(/^([A-Za-z_$][\w$]*)\s*=\s*await\s+fetchWithRetry\s*\(/);
    const assignedName = declarationMatch?.[1] ?? assignmentMatch?.[1] ?? null;
    if (assignedName) {
      tracked.push({
        name: assignedName,
        line: index + 1,
        assignmentText: trimmed,
      });
    }

    const bodyReadMatch = trimmed.match(/\b([A-Za-z_$][\w$]*)\s*\.\s*(json|text)\s*\(/);
    if (!bodyReadMatch) continue;

    for (const candidate of tracked) {
      if (index + 1 <= candidate.line) continue;
      if (index + 1 - candidate.line > 80) continue;
      if (bodyReadMatch[1] !== candidate.name) continue;
      violations.push({
        file,
        fetchLine: candidate.line,
        bodyLine: index + 1,
        variable: candidate.name,
        method: bodyReadMatch[2],
        assignmentText: candidate.assignmentText,
        bodyReadText: trimmed,
      });
    }
  }

  return violations;
}

export function scanFetchBodyTimeouts({
  cwd = process.cwd(),
  roots = DEFAULT_ROOTS,
  knownDebt = KNOWN_FETCH_BODY_TIMEOUT_DEBT,
} = {}) {
  const violations = [];
  for (const file of collectScanFiles(cwd, roots)) {
    const source = readFileSync(resolve(cwd, file), "utf8");
    violations.push(...findFetchBodyTimeoutViolations(source, file));
  }

  const seenKeys = new Set(violations.map(makeViolationKey));
  const unexpected = violations.filter((violation) => !knownDebt.has(makeViolationKey(violation)));
  const staleDebt = [...knownDebt].filter((key) => !seenKeys.has(key));
  return { violations, unexpected, staleDebt };
}

export function main() {
  const report = scanFetchBodyTimeouts();
  if (process.argv.includes("--print-baseline")) {
    for (const violation of report.violations) {
      console.log(JSON.stringify(makeViolationKey(violation)) + ",");
    }
    return 0;
  }

  if (report.unexpected.length === 0 && report.staleDebt.length === 0) {
    console.log(`Fetch body timeout check passed (${report.violations.length} known raw body-read debt item${report.violations.length === 1 ? "" : "s"} tracked).`);
    return 0;
  }

  if (report.unexpected.length > 0) {
    console.error("New fetchWithRetry raw body reads found. Use fetchJsonWithRetry/fetchTextWithRetry or add an intentional baseline entry:");
    for (const violation of report.unexpected) {
      console.error(
        `  - ${violation.file}:${violation.bodyLine} ${violation.variable}.${violation.method}() after fetchWithRetry at line ${violation.fetchLine}`,
      );
    }
  }
  if (report.staleDebt.length > 0) {
    console.error("Stale fetch body timeout debt baseline entries should be removed:");
    for (const key of report.staleDebt) {
      console.error(`  - ${key}`);
    }
  }
  return 1;
}

runAsCli(import.meta.url, main);
