#!/usr/bin/env tsx

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PriceSourceDepthAudit, PriceSourceDepthRow } from "./audit-price-source-depth";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ContractDeployment, StablecoinMeta } from "@shared/types";
import { isRecord, numberValue, stringValue } from "@shared/lib/type-guards";
import {
  parseCoverageAuditCliArgs,
  runAsMain,
  runCoverageAuditCli,
  toPositiveInt,
} from "../lib/coverage-audit-cli";

const DIA_ASSET_QUOTATION_BASE_URL = "https://api.diadata.org/v1/assetQuotation";
const DEFAULT_TIMEOUT_MS = 8_000;

export const DIA_CHAIN_MAP: Partial<Record<string, string>> = {
  ethereum: "Ethereum",
  solana: "Solana",
  tron: "Tron",
  xrpl: "XRPL",
  bsc: "BinanceSmartChain",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
  base: "Base",
  polygon: "Polygon",
  avalanche: "Avalanche",
};

export interface DiaProbeTarget {
  stablecoinId: string;
  symbol: string;
  name: string;
  marketCapUsd: number;
  pharosPrice: number | null;
  currentSourceCount: number;
  currentSources: string[];
  chain: string;
  diaBlockchain: string;
  address: string;
}

export interface DiaQuotation {
  symbol: string | null;
  name: string | null;
  address: string | null;
  blockchain: string | null;
  price: number | null;
  priceYesterday: number | null;
  volumeYesterdayUsd: number | null;
  time: string | null;
  source: string | null;
  signature: string | null;
}

export interface DiaProbeResult extends DiaProbeTarget {
  ok: boolean;
  url: string;
  httpStatus: number | null;
  error: string | null;
  diaPrice: number | null;
  diaSymbol: string | null;
  diaName: string | null;
  diaSource: string | null;
  diaTime: string | null;
  diaAgeSec: number | null;
  timestampQuality: "fresh" | "stale" | "missing" | "invalid";
  volumeYesterdayUsd: number | null;
  agreementBps: number | null;
  sourceMetadata: {
    source: string | null;
    signaturePresent: boolean;
  };
}

export interface DiaAuditReport {
  generatedAt: string;
  source: "dia-audit-only";
  inputPath: string | null;
  targetCount: number;
  checkedCount: number;
  hitCount: number;
  freshHitCount: number;
  agreementWithin50BpsCount: number;
  skippedNoSupportedContractCount: number;
  notes: string[];
  results: DiaProbeResult[];
}

interface RunDiaAuditOptions {
  audit: PriceSourceDepthAudit;
  inputPath?: string | null;
  limit?: number;
  maxContractsPerCoin?: number;
  nowMs?: number;
  fetchImpl?: typeof fetch;
  coinMetaById?: ReadonlyMap<string, Pick<StablecoinMeta, "contracts">>;
}

interface CliOptions {
  inputPath: string | null;
  limit: number;
  maxContractsPerCoin: number;
  format: "json" | "markdown";
  reportPath: string | null;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function usage(): string {
  return [
    "Usage: npm run audit:dia-provider -- --input agents/source-depth-baseline-YYYY-MM-DD.json [options]",
    "",
    "Options:",
    "  --limit <n>                   Probe top n below-target active rows by market cap (default 100)",
    "  --max-contracts-per-coin <n>  Probe up to n supported contracts per coin (default 1)",
    "  --json                        Emit JSON instead of Markdown",
    "  --report <path>               Write report to a file instead of stdout",
  ].join("\n");
}

export function parseArgs(argv: string[]): CliOptions {
  return parseCoverageAuditCliArgs(argv, {
    createOptions: (): CliOptions => ({
      inputPath: null,
      limit: 100,
      maxContractsPerCoin: 1,
      format: "markdown",
      reportPath: null,
    }),
    includeMarkdown: false,
    allowMissingReportPath: true,
    usage,
    options: [
      {
        flag: "--input",
        kind: "value",
        allowMissingValue: true,
        apply: (options, value) => { options.inputPath = value ?? null; },
      },
      {
        flag: "--limit",
        kind: "value",
        allowMissingValue: true,
        apply: (options, value) => { options.limit = toPositiveInt(value ?? "", "--limit"); },
      },
      {
        flag: "--max-contracts-per-coin",
        kind: "value",
        allowMissingValue: true,
        apply: (options, value) => { options.maxContractsPerCoin = toPositiveInt(value ?? "", "--max-contracts-per-coin"); },
      },
    ],
  });
}

function defaultInputPath(cwd: string): string | null {
  const today = new Date().toISOString().slice(0, 10);
  const candidate = resolve(cwd, "agents", `source-depth-baseline-${today}.json`);
  return existsSync(candidate) ? candidate : null;
}

function isBelowTarget(row: PriceSourceDepthRow): boolean {
  return row.candidateSourceCount < 3 && row.price != null;
}

function toSupportedContracts(
  contracts: readonly ContractDeployment[] | undefined,
  maxContractsPerCoin: number,
): Array<{ chain: string; diaBlockchain: string; address: string }> {
  const targets: Array<{ chain: string; diaBlockchain: string; address: string }> = [];
  const seen = new Set<string>();

  for (const contract of contracts ?? []) {
    const diaBlockchain = DIA_CHAIN_MAP[contract.chain];
    if (!diaBlockchain) continue;
    const address = contract.address.trim();
    if (address.length === 0) continue;
    const key = `${contract.chain}:${address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ chain: contract.chain, diaBlockchain, address });
    if (targets.length >= maxContractsPerCoin) break;
  }

  return targets;
}

export function selectDiaProbeTargets(
  audit: Pick<PriceSourceDepthAudit, "rows">,
  options: {
    limit?: number;
    maxContractsPerCoin?: number;
    coinMetaById?: ReadonlyMap<string, Pick<StablecoinMeta, "contracts">>;
  } = {},
): {
  targets: DiaProbeTarget[];
  skippedNoSupportedContractCount: number;
} {
  const limit = options.limit ?? 100;
  const maxContractsPerCoin = options.maxContractsPerCoin ?? 1;
  const coinMetaById = options.coinMetaById ?? ACTIVE_META_BY_ID;
  const targets: DiaProbeTarget[] = [];
  let skippedNoSupportedContractCount = 0;

  const rows = audit.rows
    .filter(isBelowTarget)
    .toSorted((left, right) => right.marketCapUsd - left.marketCapUsd)
    .slice(0, limit);

  for (const row of rows) {
    const meta = coinMetaById.get(row.coinId);
    const contracts = toSupportedContracts(meta?.contracts, maxContractsPerCoin);
    if (contracts.length === 0) {
      skippedNoSupportedContractCount++;
      continue;
    }

    for (const contract of contracts) {
      targets.push({
        stablecoinId: row.coinId,
        symbol: row.symbol,
        name: row.name,
        marketCapUsd: row.marketCapUsd,
        pharosPrice: row.price,
        currentSourceCount: row.candidateSourceCount,
        currentSources: row.consensusSources,
        ...contract,
      });
    }
  }

  return { targets, skippedNoSupportedContractCount };
}

export function parseDiaQuotation(payload: unknown): DiaQuotation {
  if (!isRecord(payload)) {
    return {
      symbol: null,
      name: null,
      address: null,
      blockchain: null,
      price: null,
      priceYesterday: null,
      volumeYesterdayUsd: null,
      time: null,
      source: null,
      signature: null,
    };
  }

  return {
    symbol: stringValue(payload.Symbol),
    name: stringValue(payload.Name),
    address: stringValue(payload.Address),
    blockchain: stringValue(payload.Blockchain),
    price: numberValue(payload.Price),
    priceYesterday: numberValue(payload.PriceYesterday),
    volumeYesterdayUsd: numberValue(payload.VolumeYesterdayUSD),
    time: stringValue(payload.Time),
    source: stringValue(payload.Source),
    signature: stringValue(payload.Signature),
  };
}

function buildDiaUrl(target: Pick<DiaProbeTarget, "diaBlockchain" | "address">): string {
  return `${DIA_ASSET_QUOTATION_BASE_URL}/${encodeURIComponent(target.diaBlockchain)}/${encodeURIComponent(target.address)}`;
}

function timestampQuality(time: string | null, nowMs: number): { quality: DiaProbeResult["timestampQuality"]; ageSec: number | null } {
  if (!time) return { quality: "missing", ageSec: null };
  const parsedMs = Date.parse(time);
  if (!Number.isFinite(parsedMs)) return { quality: "invalid", ageSec: null };
  const ageSec = Math.max(0, Math.round((nowMs - parsedMs) / 1000));
  return { quality: ageSec <= 3_600 ? "fresh" : "stale", ageSec };
}

function agreementBps(left: number | null, right: number | null): number | null {
  if (left == null || right == null || right <= 0) return null;
  return Math.abs((left - right) / right) * 10_000;
}

async function fetchDiaQuotation(
  target: DiaProbeTarget,
  fetchImpl: typeof fetch,
): Promise<{ status: number; payload: unknown }> {
  const url = buildDiaUrl(target);
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { status: response.status, payload: null };
  }
  return { status: response.status, payload: await response.json() };
}

export async function runDiaProviderPocAudit({
  audit,
  inputPath = null,
  limit = 100,
  maxContractsPerCoin = 1,
  nowMs = Date.now(),
  fetchImpl = fetch,
  coinMetaById = ACTIVE_META_BY_ID,
}: RunDiaAuditOptions): Promise<DiaAuditReport> {
  const { targets, skippedNoSupportedContractCount } = selectDiaProbeTargets(audit, {
    limit,
    maxContractsPerCoin,
    coinMetaById,
  });
  const results: DiaProbeResult[] = [];

  for (const target of targets) {
    const url = buildDiaUrl(target);
    try {
      const response = await fetchDiaQuotation(target, fetchImpl);
      const quotation = parseDiaQuotation(response.payload);
      const timestamp = timestampQuality(quotation.time, nowMs);
      results.push({
        ...target,
        ok: quotation.price != null && quotation.price > 0,
        url,
        httpStatus: response.status,
        error: null,
        diaPrice: quotation.price,
        diaSymbol: quotation.symbol,
        diaName: quotation.name,
        diaSource: quotation.source,
        diaTime: quotation.time,
        diaAgeSec: timestamp.ageSec,
        timestampQuality: timestamp.quality,
        volumeYesterdayUsd: quotation.volumeYesterdayUsd,
        agreementBps: agreementBps(quotation.price, target.pharosPrice),
        sourceMetadata: {
          source: quotation.source,
          signaturePresent: quotation.signature != null,
        },
      });
    } catch (error) {
      results.push({
        ...target,
        ok: false,
        url,
        httpStatus: null,
        error: error instanceof Error ? error.message : String(error),
        diaPrice: null,
        diaSymbol: null,
        diaName: null,
        diaSource: null,
        diaTime: null,
        diaAgeSec: null,
        timestampQuality: "missing",
        volumeYesterdayUsd: null,
        agreementBps: null,
        sourceMetadata: {
          source: null,
          signaturePresent: false,
        },
      });
    }
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    source: "dia-audit-only",
    inputPath,
    targetCount: targets.length,
    checkedCount: results.length,
    hitCount: results.filter((result) => result.ok).length,
    freshHitCount: results.filter((result) => result.ok && result.timestampQuality === "fresh").length,
    agreementWithin50BpsCount: results.filter((result) => result.ok && (result.agreementBps ?? Infinity) <= 50).length,
    skippedNoSupportedContractCount,
    notes: [
      "Audit-only probe. Do not wire DIA into consensus, depeg confirmation, or source-depth claims from this report alone.",
      "Targets are below-3-source active rows ranked by market cap, probed only by exact supported chain/address contracts.",
      "DIA free API is unauthenticated; production usage and trust tier still require false-positive review and methodology approval.",
    ],
    results,
  };
}

function renderMarkdown(report: DiaAuditReport): string {
  const lines = [
    `# DIA Provider POC Audit - ${report.generatedAt.slice(0, 10)}`,
    "",
    "Audit-only probe. No consensus integration, registry promotion, or depeg-authority claim is implied.",
    "",
    "## Summary",
    "",
    `- Targets checked: \`${report.checkedCount}/${report.targetCount}\``,
    `- Hits: \`${report.hitCount}\``,
    `- Fresh hits: \`${report.freshHitCount}\``,
    `- Within 50 bps of Pharos: \`${report.agreementWithin50BpsCount}\``,
    `- Below-target rows skipped for no supported exact contract: \`${report.skippedNoSupportedContractCount}\``,
    "",
    "## Results",
    "",
    "| Asset | Chain | Sources | DIA price | Pharos price | Agreement bps | Time | Source | URL |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |",
  ];

  for (const result of report.results) {
    lines.push([
      `\`${result.stablecoinId}\``,
      result.chain,
      String(result.currentSourceCount),
      result.diaPrice == null ? "n/a" : result.diaPrice.toFixed(8),
      result.pharosPrice == null ? "n/a" : result.pharosPrice.toFixed(8),
      result.agreementBps == null ? "n/a" : result.agreementBps.toFixed(1),
      result.diaTime ?? result.error ?? "n/a",
      result.diaSource ?? "n/a",
      result.url,
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  lines.push("", "## Notes", "", ...report.notes.map((note) => `- ${note}`), "");
  return `${lines.join("\n")}\n`;
}

export async function runCli(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  return runCoverageAuditCli(argv, {
    parse: parseArgs,
    cwd,
    build: async (options) => {
      const inputPath = options.inputPath ? resolve(cwd, options.inputPath) : defaultInputPath(cwd);
      if (!inputPath) {
        throw new Error("No input audit found. Pass --input agents/source-depth-baseline-YYYY-MM-DD.json.");
      }
      const audit = readJsonFile(inputPath) as PriceSourceDepthAudit;
      return runDiaProviderPocAudit({
        audit,
        inputPath,
        limit: options.limit,
        maxContractsPerCoin: options.maxContractsPerCoin,
        fetchImpl,
      });
    },
    renderMarkdown,
    writeMessage: (target) => `Wrote DIA provider POC audit to ${target}`,
  });
}

runAsMain(import.meta.url, runCli);
