#!/usr/bin/env tsx

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatDexPricingAuditUsd as formatUsd } from "@shared/lib/format";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
import { isRecord, numberValue, stringValue } from "@shared/lib/type-guards";
import {
  circulatingForStablecoinRow,
  parseReportCliArgs,
  runAsMain,
  runReportCli,
  type UnknownRecord,
} from "../lib/report-cli";

const MATERIAL_DEX_TVL_USD = 500_000;
const HIGH_PRIORITY_DEX_TVL_USD = 5_000_000;
const HIGH_PRIORITY_MCAP_USD = 50_000_000;
const LOW_SOURCE_DEPTH = 2;
const PROTOCOL_SOURCE_MIN_TVL_USD = 50_000;
const DEFAULT_CURVE_CONFIG_PATH = "worker/src/lib/curve-pool-configs.ts";

export interface DexGapStablecoinRow {
  id: string;
  symbol: string;
  name?: string;
  price?: number | null;
  priceSource?: string | null;
  priceConfidence?: string | null;
  consensusSources?: string[];
  agreeSources?: string[];
  marketCapUsd?: number;
  circulating?: Record<string, number>;
  contracts?: Array<{ chain: string; address: string; decimals?: number }>;
  tradedContracts?: Array<{ chain: string; address: string; decimals?: number }>;
}

export interface DexGapDexPriceRow {
  stablecoin_id: string;
  dex_price_usd?: number | null;
  source_pool_count?: number | null;
  source_total_tvl?: number | null;
  price_sources_json?: string | null;
  updated_at?: number | null;
}

export interface DexGapDexLiquidityRow {
  stablecoin_id: string;
  symbol?: string | null;
  total_tvl_usd?: number | null;
  total_volume_24h_usd?: number | null;
  pool_count?: number | null;
  source_mix_json?: string | null;
  top_pools_json?: string | null;
}

export interface DexProtocolSourceSnapshot {
  protocol: string;
  chain?: string;
  price?: number | null;
  tvl?: number | null;
  updatedAt?: number | null;
}

export interface CurvePoolCandidate {
  stablecoinId: string;
  poolAddress: string;
  chain: string;
  tvlUsd: number;
  inputIndex: number;
  outputIndex: number;
  inputDecimals: number;
  outputDecimals: number;
  referenceSymbol: string;
  referenceStablecoinId?: string | null;
  routeType?: "direct" | "hop" | "chained-hop" | "trusted-wrapper";
}

export interface RegistryGapRow {
  stablecoinId: string;
  symbol: string;
  protocol: string;
  sourceKey: string;
  dexTvlUsd: number;
  protocolTvlUsd: number;
}

export interface DexAdmissionGapRow {
  stablecoinId: string;
  symbol: string;
  currentSources: string[];
  dexTvlUsd: number;
  dexPriceUsd: number | null;
  protocolSources: Array<{ protocol: string; sourceKey: string; tvlUsd: number; mapped: boolean }>;
  suspectedReason: "aggregate-suppressed-by-rejected-protocol" | "material-dex-not-in-primary";
}

export interface CurveConfigGapRow extends CurvePoolCandidate {
  configured: boolean;
  priority: "P0" | "P1" | "P2";
}

export interface ProviderTargetingGapRow {
  stablecoinId: string;
  symbol: string;
  currentSources: string[];
  sourceDepth: number;
  marketCapUsd: number;
  dexTvlUsd: number;
  deploymentCount: number;
  reason: "low-depth-exact-address-material-dex" | "missing-price-exact-address-material-dex";
}

export interface DexPricingSourceGapAudit {
  generatedAt: string;
  thresholds: {
    materialDexTvlUsd: number;
    highPriorityDexTvlUsd: number;
    highPriorityMarketCapUsd: number;
    lowSourceDepth: number;
  };
  summary: {
    stablecoins: number;
    dexPriceRows: number;
    materialDexRows: number;
    registryGaps: number;
    dexAdmissionGaps: number;
    curveConfigGaps: number;
    providerTargetingGaps: number;
  };
  registryGaps: RegistryGapRow[];
  dexAdmissionGaps: DexAdmissionGapRow[];
  curveConfigGaps: CurveConfigGapRow[];
  providerTargetingGaps: ProviderTargetingGapRow[];
  warnings: string[];
}

interface BuildAuditInput {
  stablecoins: DexGapStablecoinRow[];
  dexPrices: DexGapDexPriceRow[];
  dexLiquidity?: DexGapDexLiquidityRow[];
  curveCandidates?: CurvePoolCandidate[];
  configuredCurveStablecoinIds?: Set<string>;
  generatedAt?: string;
}

interface CliOptions {
  stablecoinsPath: string | null;
  priceDepthPath: string | null;
  dexPricesPath: string | null;
  dexLiquidityPath: string | null;
  curveCandidatesPath: string | null;
  reportPath: string | null;
  format: "markdown" | "json";
  generatedAt: string | null;
}

function asRecordArray(value: unknown): UnknownRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.results)) return value.results.filter(isRecord);
  if (Array.isArray((value as { result?: unknown[] }).result)) {
    return ((value as { result: unknown[] }).result).filter(isRecord);
  }
  return [];
}

function unwrapRows(payload: unknown): UnknownRecord[] {
  if (Array.isArray(payload) && payload.length === 1 && isRecord(payload[0]) && Array.isArray(payload[0].results)) {
    return payload[0].results.filter(isRecord);
  }
  if (isRecord(payload) && Array.isArray(payload.results)) return payload.results.filter(isRecord);
  return asRecordArray(payload);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function expandedSources(row: DexGapStablecoinRow): string[] {
  const rawSources = [
    ...(row.consensusSources ?? []),
    ...(row.agreeSources ?? []),
    ...(row.priceSource ? [row.priceSource] : []),
  ];
  return uniqueStrings(rawSources.flatMap((source) => splitCompositePriceSource(source)));
}

function sourceDepth(row: DexGapStablecoinRow): number {
  return row.consensusSources?.length ?? expandedSources(row).length;
}

function marketCapUsd(row: DexGapStablecoinRow): number {
  if (typeof row.marketCapUsd === "number" && Number.isFinite(row.marketCapUsd)) return row.marketCapUsd;
  return circulatingForStablecoinRow(row);
}

function deploymentCount(row: DexGapStablecoinRow): number {
  return (row.contracts?.length ?? 0) + (row.tradedContracts?.length ?? 0);
}

function parseProtocolSources(row: DexGapDexPriceRow, warnings: string[]): DexProtocolSourceSnapshot[] {
  if (!row.price_sources_json) return [];
  try {
    const parsed = JSON.parse(row.price_sources_json) as unknown;
    if (!Array.isArray(parsed)) {
      warnings.push(`${row.stablecoin_id}: price_sources_json is not an array.`);
      return [];
    }
    return parsed.filter(isRecord).flatMap((entry) => {
      const protocol = stringValue(entry.protocol);
      if (!protocol) return [];
      return [{
        protocol,
        chain: stringValue(entry.chain) ?? undefined,
        price: numberValue(entry.price),
        tvl: numberValue(entry.tvl),
        updatedAt: numberValue(entry.updatedAt),
      }];
    });
  } catch {
    warnings.push(`${row.stablecoin_id}: malformed price_sources_json.`);
    return [];
  }
}

export function extractConfiguredCurveStablecoinIds(source: string): Set<string> {
  const ids = new Set<string>();
  const stablecoinIdPattern = /stablecoinId:\s*"([^"]+)"/g;
  for (const match of source.matchAll(stablecoinIdPattern)) {
    ids.add(match[1]);
  }
  return ids;
}

function loadConfiguredCurveStablecoinIds(warnings: string[]): Set<string> {
  try {
    return extractConfiguredCurveStablecoinIds(readFileSync(resolve(DEFAULT_CURVE_CONFIG_PATH), "utf8"));
  } catch (err) {
    warnings.push(
      `Unable to read ${DEFAULT_CURVE_CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Set();
  }
}

function hasDexPrimarySource(sources: string[], protocols: DexProtocolSourceSnapshot[]): boolean {
  if (sources.includes("dex-promoted")) return true;
  return protocols.some((source) => sources.includes(`${source.protocol}-dex`));
}

function priorityForCurveCandidate(candidate: CurvePoolCandidate): "P0" | "P1" | "P2" {
  if (candidate.tvlUsd >= HIGH_PRIORITY_DEX_TVL_USD && candidate.routeType !== "trusted-wrapper") return "P0";
  if (candidate.tvlUsd >= MATERIAL_DEX_TVL_USD && (candidate.routeType ?? "direct") === "direct") return "P1";
  return "P2";
}

export function buildDexPricingSourceGapAudit(input: BuildAuditInput): DexPricingSourceGapAudit {
  const warnings: string[] = [];
  const stableById = new Map(input.stablecoins.map((row) => [row.id, row]));
  const dexLiquidityById = new Map((input.dexLiquidity ?? []).map((row) => [row.stablecoin_id, row]));
  const configuredCurveStablecoinIds =
    input.configuredCurveStablecoinIds ?? loadConfiguredCurveStablecoinIds(warnings);

  const registryGaps: RegistryGapRow[] = [];
  const dexAdmissionGaps: DexAdmissionGapRow[] = [];
  const providerTargetingGaps: ProviderTargetingGapRow[] = [];

  for (const row of input.dexPrices) {
    const dexTvlUsd = row.source_total_tvl ?? 0;
    if (!Number.isFinite(dexTvlUsd) || dexTvlUsd < MATERIAL_DEX_TVL_USD) continue;

    const stable = stableById.get(row.stablecoin_id);
    const symbol = stable?.symbol ?? dexLiquidityById.get(row.stablecoin_id)?.symbol ?? row.stablecoin_id;
    const currentSources = stable ? expandedSources(stable) : [];
    const protocols = parseProtocolSources(row, warnings);
    const protocolSummaries = protocols.map((source) => {
      const sourceKey = `${source.protocol}-dex`;
      return {
        protocol: source.protocol,
        sourceKey,
        tvlUsd: source.tvl ?? 0,
        mapped: Boolean(getPricingSourceRegistryEntry(sourceKey)),
      };
    });

    for (const source of protocolSummaries) {
      if (!source.mapped && source.tvlUsd >= PROTOCOL_SOURCE_MIN_TVL_USD) {
        registryGaps.push({
          stablecoinId: row.stablecoin_id,
          symbol,
          protocol: source.protocol,
          sourceKey: source.sourceKey,
          dexTvlUsd,
          protocolTvlUsd: source.tvlUsd,
        });
      }
    }

    const materialProtocolSources = protocolSummaries.filter((source) => source.tvlUsd >= PROTOCOL_SOURCE_MIN_TVL_USD);
    const mappedProtocolSources = materialProtocolSources.filter((source) => source.mapped);
    if (!hasDexPrimarySource(currentSources, protocols) && materialProtocolSources.length > 0) {
      dexAdmissionGaps.push({
        stablecoinId: row.stablecoin_id,
        symbol,
        currentSources,
        dexTvlUsd,
        dexPriceUsd: row.dex_price_usd ?? null,
        protocolSources: materialProtocolSources,
        suspectedReason: mappedProtocolSources.length === 1
          ? "aggregate-suppressed-by-rejected-protocol"
          : "material-dex-not-in-primary",
      });
    }

    if (stable) {
      const depth = sourceDepth(stable);
      const mcap = marketCapUsd(stable);
      const deployments = deploymentCount(stable);
      const missingPrice = stable.price == null || !Number.isFinite(stable.price) || stable.price <= 0;
      if (
        deployments > 0 &&
        !hasDexPrimarySource(currentSources, protocols) &&
        (missingPrice || depth <= LOW_SOURCE_DEPTH) &&
        (dexTvlUsd >= HIGH_PRIORITY_DEX_TVL_USD || mcap >= HIGH_PRIORITY_MCAP_USD)
      ) {
        providerTargetingGaps.push({
          stablecoinId: stable.id,
          symbol: stable.symbol,
          currentSources,
          sourceDepth: depth,
          marketCapUsd: mcap,
          dexTvlUsd,
          deploymentCount: deployments,
          reason: missingPrice ? "missing-price-exact-address-material-dex" : "low-depth-exact-address-material-dex",
        });
      }
    }
  }

  const curveConfigGaps = (input.curveCandidates ?? [])
    .map((candidate): CurveConfigGapRow => ({
      ...candidate,
      configured: configuredCurveStablecoinIds.has(candidate.stablecoinId),
      priority: priorityForCurveCandidate(candidate),
    }))
    .filter((candidate) => !candidate.configured && candidate.tvlUsd >= MATERIAL_DEX_TVL_USD)
    .sort((left, right) => right.tvlUsd - left.tvlUsd);

  registryGaps.sort((left, right) => right.protocolTvlUsd - left.protocolTvlUsd);
  dexAdmissionGaps.sort((left, right) => right.dexTvlUsd - left.dexTvlUsd);
  providerTargetingGaps.sort((left, right) => {
    if (right.dexTvlUsd !== left.dexTvlUsd) return right.dexTvlUsd - left.dexTvlUsd;
    return right.marketCapUsd - left.marketCapUsd;
  });

  const materialDexRows = input.dexPrices.filter((row) => (row.source_total_tvl ?? 0) >= MATERIAL_DEX_TVL_USD).length;

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    thresholds: {
      materialDexTvlUsd: MATERIAL_DEX_TVL_USD,
      highPriorityDexTvlUsd: HIGH_PRIORITY_DEX_TVL_USD,
      highPriorityMarketCapUsd: HIGH_PRIORITY_MCAP_USD,
      lowSourceDepth: LOW_SOURCE_DEPTH,
    },
    summary: {
      stablecoins: input.stablecoins.length,
      dexPriceRows: input.dexPrices.length,
      materialDexRows,
      registryGaps: registryGaps.length,
      dexAdmissionGaps: dexAdmissionGaps.length,
      curveConfigGaps: curveConfigGaps.length,
      providerTargetingGaps: providerTargetingGaps.length,
    },
    registryGaps,
    dexAdmissionGaps,
    curveConfigGaps,
    providerTargetingGaps,
    warnings,
  };
}

function buildStablecoinRow(
  id: string,
  row: Record<string, unknown>,
  extras?: Pick<DexGapStablecoinRow, "circulating" | "contracts" | "tradedContracts">,
): DexGapStablecoinRow {
  return {
    id,
    symbol: stringValue(row.symbol) ?? id.toUpperCase(),
    name: stringValue(row.name) ?? undefined,
    price: numberValue(row.price),
    priceSource: stringValue(row.priceSource),
    priceConfidence: stringValue(row.priceConfidence),
    consensusSources: Array.isArray(row.consensusSources) ? uniqueStrings(row.consensusSources.filter((s): s is string => typeof s === "string")) : [],
    agreeSources: Array.isArray(row.agreeSources) ? uniqueStrings(row.agreeSources.filter((s): s is string => typeof s === "string")) : [],
    marketCapUsd: numberValue(row.marketCapUsd) ?? undefined,
    ...extras,
  };
}

function normalizeStablecoinRows(payload: unknown): DexGapStablecoinRow[] {
  if (isRecord(payload) && Array.isArray(payload.rows)) {
    return payload.rows.filter(isRecord).flatMap((row) => {
      const id = stringValue(row.coinId ?? row.id);
      if (!id) return [];
      return [buildStablecoinRow(id, row)];
    });
  }

  const rows = isRecord(payload) && Array.isArray(payload.peggedAssets) ? payload.peggedAssets : payload;
  return unwrapRows(rows).flatMap((row) => {
    const id = stringValue(row.id);
    if (!id) return [];
    return [buildStablecoinRow(id, row, {
      circulating: isRecord(row.circulating) ? row.circulating as Record<string, number> : undefined,
      contracts: Array.isArray(row.contracts) ? row.contracts as DexGapStablecoinRow["contracts"] : undefined,
      tradedContracts: Array.isArray(row.tradedContracts) ? row.tradedContracts as DexGapStablecoinRow["tradedContracts"] : undefined,
    })];
  });
}

function normalizeDexPriceRows(payload: unknown): DexGapDexPriceRow[] {
  return unwrapRows(payload).flatMap((row) => {
    const stablecoinId = stringValue(row.stablecoin_id ?? row.stablecoinId);
    if (!stablecoinId) return [];
    return [{
      stablecoin_id: stablecoinId,
      dex_price_usd: numberValue(row.dex_price_usd ?? row.dexPriceUsd),
      source_pool_count: numberValue(row.source_pool_count ?? row.sourcePoolCount),
      source_total_tvl: numberValue(row.source_total_tvl ?? row.sourceTotalTvl),
      price_sources_json: stringValue(row.price_sources_json ?? row.priceSourcesJson),
      updated_at: numberValue(row.updated_at ?? row.updatedAt),
    }];
  });
}

function normalizeDexLiquidityRows(payload: unknown): DexGapDexLiquidityRow[] {
  return unwrapRows(payload).flatMap((row) => {
    const stablecoinId = stringValue(row.stablecoin_id ?? row.stablecoinId);
    if (!stablecoinId) return [];
    return [{
      stablecoin_id: stablecoinId,
      symbol: stringValue(row.symbol),
      total_tvl_usd: numberValue(row.total_tvl_usd ?? row.totalTvlUsd),
      total_volume_24h_usd: numberValue(row.total_volume_24h_usd ?? row.totalVolume24hUsd),
      pool_count: numberValue(row.pool_count ?? row.poolCount),
      source_mix_json: stringValue(row.source_mix_json ?? row.sourceMixJson),
      top_pools_json: stringValue(row.top_pools_json ?? row.topPoolsJson),
    }];
  });
}

function normalizeCurveCandidates(payload: unknown): CurvePoolCandidate[] {
  return unwrapRows(payload).flatMap((row) => {
    const stablecoinId = stringValue(row.stablecoinId ?? row.stablecoin_id);
    const poolAddress = stringValue(row.poolAddress ?? row.pool_address);
    const chain = stringValue(row.chain);
    const tvlUsd = numberValue(row.tvlUsd ?? row.tvl_usd);
    const inputIndex = numberValue(row.inputIndex ?? row.input_index);
    const outputIndex = numberValue(row.outputIndex ?? row.output_index);
    const inputDecimals = numberValue(row.inputDecimals ?? row.input_decimals);
    const outputDecimals = numberValue(row.outputDecimals ?? row.output_decimals);
    const referenceSymbol = stringValue(row.referenceSymbol ?? row.reference_symbol);
    if (
      !stablecoinId ||
      !poolAddress ||
      !chain ||
      tvlUsd == null ||
      inputIndex == null ||
      outputIndex == null ||
      inputDecimals == null ||
      outputDecimals == null ||
      !referenceSymbol
    ) {
      return [];
    }
    return [{
      stablecoinId,
      poolAddress,
      chain,
      tvlUsd,
      inputIndex,
      outputIndex,
      inputDecimals,
      outputDecimals,
      referenceSymbol,
      referenceStablecoinId: stringValue(row.referenceStablecoinId ?? row.reference_stablecoin_id),
      routeType: stringValue(row.routeType ?? row.route_type) as CurvePoolCandidate["routeType"] ?? "direct",
    }];
  });
}

export function renderDexPricingSourceGapMarkdown(audit: DexPricingSourceGapAudit): string {
  const lines: string[] = [
    `# DEX Pricing Source Gap Audit - ${audit.generatedAt.slice(0, 10)}`,
    "",
    "## Summary",
    "",
    `- Stablecoins: ${audit.summary.stablecoins}`,
    `- DEX price rows: ${audit.summary.dexPriceRows}`,
    `- Material DEX rows: ${audit.summary.materialDexRows}`,
    `- Registry gaps: ${audit.summary.registryGaps}`,
    `- DEX admission gaps: ${audit.summary.dexAdmissionGaps}`,
    `- Curve config gaps: ${audit.summary.curveConfigGaps}`,
    `- Provider targeting gaps: ${audit.summary.providerTargetingGaps}`,
    "",
  ];

  lines.push("## Registry Gaps", "");
  if (audit.registryGaps.length === 0) {
    lines.push("No material unmapped DEX protocol source keys found.", "");
  } else {
    lines.push("| Asset | Protocol | Source key | Protocol TVL | Total DEX TVL |", "| --- | --- | --- | --- | --- |");
    for (const row of audit.registryGaps.slice(0, 50)) {
      lines.push(`| \`${row.stablecoinId}\` / ${row.symbol} | ${row.protocol} | \`${row.sourceKey}\` | ${formatUsd(row.protocolTvlUsd)} | ${formatUsd(row.dexTvlUsd)} |`);
    }
    lines.push("");
  }

  lines.push("## DEX Admission Gaps", "");
  if (audit.dexAdmissionGaps.length === 0) {
    lines.push("No material DEX rows without a primary DEX source found.", "");
  } else {
    lines.push("| Asset | Suspected reason | DEX TVL | Current sources | Protocol sources |", "| --- | --- | --- | --- | --- |");
    for (const row of audit.dexAdmissionGaps.slice(0, 50)) {
      const protocols = row.protocolSources
        .map((source) => `${source.protocol}${source.mapped ? "" : " (unmapped)"} ${formatUsd(source.tvlUsd)}`)
        .join(", ");
      lines.push(`| \`${row.stablecoinId}\` / ${row.symbol} | ${row.suspectedReason} | ${formatUsd(row.dexTvlUsd)} | ${row.currentSources.map((source) => `\`${source}\``).join(", ") || "none"} | ${protocols} |`);
    }
    lines.push("");
  }

  lines.push("## Curve Config Gaps", "");
  if (audit.curveConfigGaps.length === 0) {
    lines.push("No provided Curve candidates are missing hard configs.", "");
  } else {
    lines.push("| Priority | Asset | Pool | Chain | Ref | TVL | Route |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const row of audit.curveConfigGaps) {
      lines.push(`| ${row.priority} | \`${row.stablecoinId}\` | \`${row.poolAddress}\` | ${row.chain} | ${row.referenceSymbol} | ${formatUsd(row.tvlUsd)} | ${row.routeType ?? "direct"} |`);
    }
    lines.push("");
  }

  lines.push("## Provider Targeting Gaps", "");
  if (audit.providerTargetingGaps.length === 0) {
    lines.push("No low-depth exact-address provider targets found.", "");
  } else {
    lines.push("| Asset | Reason | Source depth | Market cap | DEX TVL | Deployments |", "| --- | --- | --- | --- | --- | --- |");
    for (const row of audit.providerTargetingGaps.slice(0, 50)) {
      lines.push(`| \`${row.stablecoinId}\` / ${row.symbol} | ${row.reason} | ${row.sourceDepth} | ${formatUsd(row.marketCapUsd)} | ${formatUsd(row.dexTvlUsd)} | ${row.deploymentCount} |`);
    }
    lines.push("");
  }

  if (audit.warnings.length > 0) {
    lines.push("## Warnings", "", ...audit.warnings.map((warning) => `- ${warning}`), "");
  }

  return `${lines.join("\n")}\n`;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function parseCliArgs(argv: string[]): CliOptions {
  return parseReportCliArgs(argv, {
    createOptions: (): CliOptions => ({
      stablecoinsPath: null,
      priceDepthPath: null,
      dexPricesPath: null,
      dexLiquidityPath: null,
      curveCandidatesPath: null,
      reportPath: null,
      format: "markdown",
      generatedAt: null,
    }),
    includeGeneratedAt: true,
    allowMissingGeneratedAt: true,
    allowMissingReportPath: true,
    compat: { ignoreUnknownArguments: true },
    options: [
      { flag: "--stablecoins", kind: "value", allowMissingValue: true, apply: (options, value) => { options.stablecoinsPath = value ?? null; } },
      { flag: "--price-depth", kind: "value", allowMissingValue: true, apply: (options, value) => { options.priceDepthPath = value ?? null; } },
      { flag: "--dex-prices", kind: "value", allowMissingValue: true, apply: (options, value) => { options.dexPricesPath = value ?? null; } },
      { flag: "--dex-liquidity", kind: "value", allowMissingValue: true, apply: (options, value) => { options.dexLiquidityPath = value ?? null; } },
      { flag: "--curve-candidates", kind: "value", allowMissingValue: true, apply: (options, value) => { options.curveCandidatesPath = value ?? null; } },
    ],
  });
}

export async function runCli(argv = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  return runReportCli(argv, {
    parse: parseCliArgs,
    cwd,
    build: (options) => {
      const stablecoinsPath = options.priceDepthPath ?? options.stablecoinsPath;
      const dexPricesPath = options.dexPricesPath;
      if (!stablecoinsPath || !dexPricesPath) {
        throw new Error("Usage: audit-dex-pricing-source-gaps.ts (--price-depth <path> | --stablecoins <path>) --dex-prices <path> [--dex-liquidity <path>] [--curve-candidates <path>] [--report <path>] [--json]");
      }

      const stablecoins = normalizeStablecoinRows(readJson(resolve(cwd, stablecoinsPath)));
      const dexPrices = normalizeDexPriceRows(readJson(resolve(cwd, dexPricesPath)));
      const dexLiquidity = options.dexLiquidityPath
        ? normalizeDexLiquidityRows(readJson(resolve(cwd, options.dexLiquidityPath)))
        : [];
      const curveCandidates = options.curveCandidatesPath
        ? normalizeCurveCandidates(readJson(resolve(cwd, options.curveCandidatesPath)))
        : [];

      return buildDexPricingSourceGapAudit({
        stablecoins,
        dexPrices,
        dexLiquidity,
        curveCandidates,
        generatedAt: options.generatedAt ?? undefined,
      });
    },
    renderMarkdown: renderDexPricingSourceGapMarkdown,
  });
}

runAsMain(import.meta.url, runCli);
