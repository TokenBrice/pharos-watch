#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHAIN_META } from "@shared/lib/chains";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const DEFAULT_API_URL = "https://www.eurostablecoins.xyz/api/v1/coins";
const SOURCE_URL = "https://www.eurostablecoins.xyz/";
const SOURCE_LICENSE_NOTE = "eurostablecoins.xyz API data is published with CC BY 4.0 attribution requested.";

const MARKET_STATUS_MAP = {
  market_traded: "market-traded",
  limited_trading: "limited-trading",
  non_traded_utility: "non-traded-utility",
  legacy_or_wind_down: "legacy-or-wind-down",
};

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COIN_DIR = path.join(ROOT_DIR, "shared/data/stablecoins/coins");
const DEAD_STABLECOINS_PATH = path.join(ROOT_DIR, "shared/data/dead-stablecoins.json");
interface AuditCoin {
  id?: string; symbol?: string; status?: string; marketAvailability?: string;
  contracts?: { chain?: string }[];
  coin_id?: unknown; ticker?: unknown; name?: unknown; issuer_full?: unknown; issuer?: unknown; market_status?: string;
  mica_status?: unknown; mica_jurisdiction?: unknown; total_supply?: unknown; circulating_supply?: unknown;
  treasury_held?: unknown; recorded_at?: unknown; chains?: unknown[];
}

interface AuditInput {
  externalCoins: readonly AuditCoin[]; localCoins: readonly AuditCoin[]; deadCoins: readonly AuditCoin[];
  supportedChains: ReadonlySet<string>; generatedAt: string; apiUrl: string;
}

function parseArgs(argv: readonly string[]) {
  const options: { apiUrl: string; format: string; reportPath: string | null } = {
    apiUrl: DEFAULT_API_URL,
    format: "markdown",
    reportPath: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.format = "json";
    } else if (arg === "--report") {
      options.reportPath = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--api-url") {
      options.apiUrl = argv[i + 1] ?? DEFAULT_API_URL;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.reportPath === "") {
    throw new Error("--report requires a path");
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/maintenance/audit-eurostablecoins-coverage.ts [--json] [--report <path>] [--api-url <url>]

Compares Pharos' checked-in EUR stablecoin metadata against eurostablecoins.xyz.
The script is read-only unless --report is provided.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSymbol(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function normalizeChain(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function normalizeMarketStatus(value: unknown) {
  return (typeof value === "string" ? MARKET_STATUS_MAP[value as keyof typeof MARKET_STATUS_MAP] ?? value : value) ?? null;
}

function formatNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function loadLocalCoins() {
  const filenames = (await readdir(COIN_DIR)).filter((file) => file.endsWith(".json")).sort();
  const coins = [];
  for (const filename of filenames) {
    const coin = await readJson(path.join(COIN_DIR, filename)) as AuditCoin;
    coins.push({ ...coin, _sourceFile: path.join("shared/data/stablecoins/coins", filename) });
  }
  return coins;
}

async function loadDeadStablecoins() {
  const rows = await readJson(DEAD_STABLECOINS_PATH);
  if (!Array.isArray(rows)) {
    throw new Error("dead-stablecoins.json must be an array");
  }
  return rows as AuditCoin[];
}

export function loadSupportedChains(): Set<string> {
  return new Set(Object.keys(CHAIN_META));
}

async function fetchEurostablecoins(apiUrl: string): Promise<AuditCoin[]> {
  const response = await fetch(apiUrl, {
    headers: {
      accept: "application/json",
      "user-agent": "pharos-watch-eurostablecoins-coverage-audit",
    },
  });
  if (!response.ok) {
    throw new Error(`eurostablecoins API returned ${response.status}`);
  }

  const payload = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.coins)) {
    throw new Error("eurostablecoins API returned an unexpected payload");
  }
  return payload.coins as AuditCoin[];
}

function buildSymbolIndex(coins: readonly AuditCoin[]) {
  const index = new Map<string, AuditCoin[]>();
  for (const coin of coins) {
    const symbol = normalizeSymbol(coin.symbol);
    if (!symbol) continue;
    const existing = index.get(symbol);
    if (existing) {
      existing.push(coin);
    } else {
      index.set(symbol, [coin]);
    }
  }
  return index;
}

function contractChains(coin: AuditCoin) {
  const chains = new Set<string>();
  for (const deployment of coin.contracts ?? []) {
    if (deployment?.chain) chains.add(normalizeChain(deployment.chain));
  }
  return chains;
}

export function buildAudit({
  externalCoins,
  localCoins,
  deadCoins,
  supportedChains,
  generatedAt,
  apiUrl,
}: AuditInput) {
  const localBySymbol = buildSymbolIndex(localCoins);
  const deadBySymbol = buildSymbolIndex(deadCoins);
  const externalRows = externalCoins.map((coin) => ({
    coinId: coin.coin_id,
    ticker: coin.ticker,
    symbolKey: normalizeSymbol(coin.ticker),
    name: coin.name,
    issuer: coin.issuer_full ?? coin.issuer,
    marketAvailability: normalizeMarketStatus(coin.market_status),
    micaStatus: coin.mica_status ?? null,
    micaJurisdiction: coin.mica_jurisdiction ?? null,
    totalSupply: typeof coin.total_supply === "number" ? coin.total_supply : null,
    circulatingSupply: typeof coin.circulating_supply === "number" ? coin.circulating_supply : null,
    treasuryHeld: typeof coin.treasury_held === "number" ? coin.treasury_held : null,
    recordedAt: coin.recorded_at ?? null,
    chains: Array.isArray(coin.chains) ? coin.chains.map(normalizeChain).filter(Boolean) : [],
  }));

  const missingReadable = [];
  const cemeteryOnly = [];
  const duplicateLocalSymbols = [];
  const marketAvailabilityGaps = [];
  const supportedContractGaps = [];
  const unsupportedContractGaps = [];
  const treasuryHeldRows = [];

  for (const row of externalRows) {
    const localMatches = localBySymbol.get(row.symbolKey) ?? [];
    const readableMatches = localMatches.filter((coin) => coin.status !== "pre-launch");
    const deadMatches = deadBySymbol.get(row.symbolKey) ?? [];

    if (localMatches.length > 1) {
      duplicateLocalSymbols.push({
        ticker: row.ticker,
        localIds: localMatches.map((coin) => coin.id),
      });
    }

    if (readableMatches.length === 0) {
      if (deadMatches.length > 0) {
        cemeteryOnly.push({
          ...row,
          deadIds: deadMatches.map((coin) => coin.id),
        });
      } else {
        missingReadable.push(row);
      }
      continue;
    }

    const primary = readableMatches[0];
    if (row.marketAvailability && primary.marketAvailability !== row.marketAvailability) {
      marketAvailabilityGaps.push({
        ticker: row.ticker,
        localId: primary.id,
        localValue: primary.marketAvailability ?? null,
        externalValue: row.marketAvailability,
      });
    }

    const localChains = contractChains(primary);
    const missingChains = row.chains.filter((chain) => !localChains.has(chain));
    const supported = missingChains.filter((chain) => supportedChains.has(chain));
    const unsupported = missingChains.filter((chain) => !supportedChains.has(chain));

    if (supported.length > 0) {
      supportedContractGaps.push({
        ticker: row.ticker,
        localId: primary.id,
        chains: supported,
      });
    }
    if (unsupported.length > 0) {
      unsupportedContractGaps.push({
        ticker: row.ticker,
        localId: primary.id,
        chains: unsupported,
      });
    }

    if ((row.treasuryHeld ?? 0) > 0) {
      treasuryHeldRows.push({
        ticker: row.ticker,
        localId: primary.id,
        treasuryHeld: row.treasuryHeld,
        totalSupply: row.totalSupply,
      });
    }
  }

  return {
    generatedAt,
    source: {
      apiUrl,
      site: SOURCE_URL,
      licenseNote: SOURCE_LICENSE_NOTE,
    },
    summary: {
      externalCoinCount: externalRows.length,
      localReadableMatchCount: externalRows.length - missingReadable.length - cemeteryOnly.length,
      missingReadableCount: missingReadable.length,
      cemeteryOnlyCount: cemeteryOnly.length,
      marketAvailabilityGapCount: marketAvailabilityGaps.length,
      supportedContractGapCount: supportedContractGaps.length,
      unsupportedContractGapCount: unsupportedContractGaps.length,
      treasuryHeldSignalCount: treasuryHeldRows.length,
    },
    missingReadable,
    cemeteryOnly,
    duplicateLocalSymbols,
    marketAvailabilityGaps,
    supportedContractGaps,
    unsupportedContractGaps,
    treasuryHeldRows,
  };
}

function markdownTable(headers: readonly string[], rows: readonly (readonly unknown[])[]) {
  if (rows.length === 0) return "_None._";
  const header = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`);
  return [header, separator, ...body].join("\n");
}

export function renderMarkdown(audit: ReturnType<typeof buildAudit>) {
  const lines = [
    "# Eurostablecoins Coverage Audit",
    "",
    `Generated: ${audit.generatedAt}`,
    `Source: ${audit.source.site} (${audit.source.licenseNote})`,
    "",
    "## Summary",
    "",
    markdownTable(
      ["Metric", "Count"],
      Object.entries(audit.summary).map(([key, value]) => [key, String(value)]),
    ),
    "",
    "## Missing From Readable Pharos Registry",
    "",
    markdownTable(
      ["Ticker", "Name", "Issuer", "Market availability", "Supply"],
      audit.missingReadable.map((row) => [
        row.ticker,
        row.name,
        row.issuer ?? "",
        row.marketAvailability ?? "",
        formatNumber(row.totalSupply),
      ]),
    ),
    "",
    "## Cemetery-Only Matches",
    "",
    markdownTable(
      ["Ticker", "Name", "Dead IDs", "External market availability", "Supply"],
      audit.cemeteryOnly.map((row) => [
        row.ticker,
        row.name,
        row.deadIds.join(", "),
        row.marketAvailability ?? "",
        formatNumber(row.totalSupply),
      ]),
    ),
    "",
    "## Market Availability Gaps",
    "",
    markdownTable(
      ["Ticker", "Local ID", "Local", "External"],
      audit.marketAvailabilityGaps.map((row) => [
        row.ticker,
        row.localId,
        row.localValue ?? "",
        row.externalValue ?? "",
      ]),
    ),
    "",
    "## Supported Contract Gaps",
    "",
    markdownTable(
      ["Ticker", "Local ID", "Chains"],
      audit.supportedContractGaps.map((row) => [row.ticker, row.localId, row.chains.join(", ")]),
    ),
    "",
    "## Unsupported Chain Gaps",
    "",
    markdownTable(
      ["Ticker", "Local ID", "Chains"],
      audit.unsupportedContractGaps.map((row) => [row.ticker, row.localId, row.chains.join(", ")]),
    ),
    "",
    "## Treasury-Held Signals",
    "",
    markdownTable(
      ["Ticker", "Local ID", "Treasury held", "Total supply"],
      audit.treasuryHeldRows.map((row) => [
        row.ticker,
        row.localId,
        formatNumber(row.treasuryHeld),
        formatNumber(row.totalSupply),
      ]),
    ),
    "",
  ];

  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [externalCoins, localCoins, deadCoins, supportedChains] = await Promise.all([
    fetchEurostablecoins(options.apiUrl),
    loadLocalCoins(),
    loadDeadStablecoins(),
    loadSupportedChains(),
  ]);

  const audit = buildAudit({
    externalCoins,
    localCoins,
    deadCoins,
    supportedChains,
    generatedAt: new Date().toISOString(),
    apiUrl: options.apiUrl,
  });

  const output = options.format === "json" ? `${JSON.stringify(audit, null, 2)}\n` : renderMarkdown(audit);
  if (options.reportPath) {
    const reportPath = path.resolve(ROOT_DIR, options.reportPath);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, output);
  }

  process.stdout.write(output);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
