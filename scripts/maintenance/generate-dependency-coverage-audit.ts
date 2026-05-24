#!/usr/bin/env tsx

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildDependencyGraphEdges,
  filterDependencyGraphEdgesToLive,
  type DependencyGraphEdge,
} from "../../shared/lib/dependency-graph";
import { ACTIVE_STABLECOINS } from "../../shared/lib/stablecoins/registry";
import { getCirculatingRaw } from "../../shared/lib/supply";
import type { DependencyType, DependencyWeight, ReserveSlice, StablecoinMeta } from "../../shared/types";

const PROD_ORIGIN = "https://pharos.watch";
const PROD_REPORT_CARDS_URL = `${PROD_ORIGIN}/_site-data/report-cards`;
const PROD_STABLECOINS_URL = `${PROD_ORIGIN}/_site-data/stablecoins`;
const DEFAULT_BASELINE_PATH = "scripts/lib/dependency-coverage-baseline.json";
const MISSING_CANDIDATE_LIMIT = 50;
const RESERVE_SLICE_LIMIT = 50;
const MANUAL_DEPENDENCY_LIMIT = 50;

interface UnknownRecord {
  [key: string]: unknown;
}

export interface DependencyGraphCoverageSummary {
  edgeCount: number;
  activeEdgeCount: number;
  participantCount: number;
  dependentCount: number;
  upstreamOnlyCount: number;
  participantIds: string[];
  dependentIds: string[];
  upstreamOnlyIds: string[];
}

export interface ManualOnlyDependencyRow {
  coinId: string;
  symbol: string;
  dependencyId: string;
  dependencyType: DependencyType;
  weight: number;
}

export interface ReserveSliceCoverageRow {
  coinId: string;
  symbol: string;
  reserveIndex: number;
  reserveName: string;
  pct: number;
  risk: string;
  depType: DependencyType | null;
  marketCapUsd: number | null;
  rank: number;
}

export interface MissingDependencyCandidateRow {
  coinId: string;
  symbol: string;
  name: string;
  marketCapUsd: number | null;
  rank: number;
}

export interface DependencyCoverageBaseline {
  staticEdgeCount?: number;
  participantCount?: number;
  dependentCount?: number;
}

export interface DependencyCoverageAudit {
  generatedAt: string;
  mode: "static" | "input" | "api" | "prod";
  summary: {
    activeCount: number;
    staticEdgeCount: number;
    staticActiveEdgeCount: number;
    staticParticipantCount: number;
    staticDependentCount: number;
    staticUpstreamOnlyCount: number;
    reportCardEdgeCount: number | null;
    reportCardActiveEdgeCount: number | null;
    reportCardParticipantCount: number | null;
    reportCardDependentCount: number | null;
    reportCardUpstreamOnlyCount: number | null;
    manualOnlyDependencyCount: number;
    reserveSlicesMissingCoinId: number;
    depTypeWithoutCoinIdWarnings: number;
    missingCandidateCount: number;
    missingCandidateRankSource: "stablecoin-api-market-cap" | "local-canonical-order";
    missingCandidateGraphSource: "static" | "report-card";
  };
  staticGraph: DependencyGraphCoverageSummary;
  reportCardGraph: DependencyGraphCoverageSummary | null;
  manualOnlyDependencies: ManualOnlyDependencyRow[];
  reserveSlicesMissingCoinId: ReserveSliceCoverageRow[];
  depTypeWithoutCoinIdWarnings: ReserveSliceCoverageRow[];
  highestMarketCapMissingCandidates: MissingDependencyCandidateRow[];
  warnings: string[];
}

export interface DependencyCoverageAuditInput {
  activeCoins?: readonly StablecoinMeta[];
  reportCards?: unknown;
  stablecoins?: unknown;
  generatedAt?: string;
  mode?: DependencyCoverageAudit["mode"];
}

interface CliOptions {
  apiBase: string | null;
  prod: boolean;
  inputDir: string | null;
  reportCardsPath: string | null;
  stablecoinsPath: string | null;
  format: "markdown" | "json";
  reportPath: string | null;
  check: boolean;
  baselinePath: string;
  generatedAt: string | null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dependencyTypeValue(value: unknown): DependencyType {
  return value === "wrapper" || value === "mechanism" || value === "collateral" ? value : "collateral";
}

function dependencyKey(dependency: Pick<DependencyWeight, "id" | "type">): string {
  return `${dependency.id}::${dependency.type ?? "collateral"}`;
}

function summarizeDependencyGraph(
  edges: readonly DependencyGraphEdge[],
  activeIds: ReadonlySet<string>,
): DependencyGraphCoverageSummary {
  const activeEdges = filterDependencyGraphEdgesToLive(edges, activeIds);
  const sourceIds = new Set<string>();
  const dependentIds = new Set<string>();

  for (const edge of activeEdges) {
    sourceIds.add(edge.from);
    dependentIds.add(edge.to);
  }

  const participantIds = [...new Set([...sourceIds, ...dependentIds])].sort();
  const dependentIdList = [...dependentIds].sort();
  const upstreamOnlyIds = [...sourceIds].filter((id) => !dependentIds.has(id)).sort();

  return {
    edgeCount: edges.length,
    activeEdgeCount: activeEdges.length,
    participantCount: participantIds.length,
    dependentCount: dependentIdList.length,
    upstreamOnlyCount: upstreamOnlyIds.length,
    participantIds,
    dependentIds: dependentIdList,
    upstreamOnlyIds,
  };
}

function extractReportCardEdges(payload: unknown): DependencyGraphEdge[] | null {
  const envelope = isRecord(payload) && isRecord(payload.payload) ? payload.payload : payload;
  const graph = isRecord(envelope) && isRecord(envelope.dependencyGraph) ? envelope.dependencyGraph : null;
  if (!graph || !Array.isArray(graph.edges)) return null;

  return graph.edges.filter(isRecord).flatMap((edge) => {
    const from = stringValue(edge.from);
    const to = stringValue(edge.to);
    const weight = numberValue(edge.weight);
    if (!from || !to || weight == null) return [];
    return [{
      from,
      to,
      weight,
      type: dependencyTypeValue(edge.type),
    }];
  });
}

function extractStablecoinRows(payload: unknown): UnknownRecord[] {
  const envelope = isRecord(payload) && isRecord(payload.payload) ? payload.payload : payload;
  const rows = Array.isArray(envelope)
    ? envelope
    : isRecord(envelope) && Array.isArray(envelope.peggedAssets)
      ? envelope.peggedAssets
      : [];
  return rows.filter(isRecord);
}

function marketCapForStablecoinRow(row: UnknownRecord): number {
  const direct = numberValue(row.marketCapUsd ?? row.marketCap ?? row.mcapUsd);
  if (direct != null) return direct;
  return getCirculatingRaw(row as { circulating?: Record<string, number> | null | undefined });
}

function buildMarketCapMap(stablecoinsPayload: unknown | undefined): Map<string, number> | null {
  if (stablecoinsPayload === undefined) return null;

  const rows = extractStablecoinRows(stablecoinsPayload);
  const map = new Map<string, number>();
  for (const row of rows) {
    const id = stringValue(row.id);
    if (!id) continue;
    map.set(id, marketCapForStablecoinRow(row));
  }
  return map;
}

function marketCapForId(marketCapById: ReadonlyMap<string, number> | null, id: string): number | null {
  return marketCapById?.get(id) ?? null;
}

function sortByMarketCapOrRank<T extends { marketCapUsd: number | null; rank: number; coinId: string }>(rows: T[]): T[] {
  return rows.sort((left, right) => {
    if (left.marketCapUsd != null || right.marketCapUsd != null) {
      return (right.marketCapUsd ?? -1) - (left.marketCapUsd ?? -1) || left.coinId.localeCompare(right.coinId);
    }
    return left.rank - right.rank || left.coinId.localeCompare(right.coinId);
  });
}

function findManualOnlyDependencies(activeCoins: readonly StablecoinMeta[]): ManualOnlyDependencyRow[] {
  const rows: ManualOnlyDependencyRow[] = [];

  for (const coin of activeCoins) {
    const reserveDependencyKeys = new Set(
      (coin.reserves ?? [])
        .filter((reserve): reserve is ReserveSlice & { coinId: string } => Boolean(reserve.coinId))
        .map((reserve) => dependencyKey({ id: reserve.coinId, type: reserve.depType })),
    );

    for (const dependency of coin.dependencies ?? []) {
      if (reserveDependencyKeys.has(dependencyKey(dependency))) continue;
      rows.push({
        coinId: coin.id,
        symbol: coin.symbol,
        dependencyId: dependency.id,
        dependencyType: dependency.type ?? "collateral",
        weight: dependency.weight,
      });
    }
  }

  return rows.sort((left, right) => (
    left.coinId.localeCompare(right.coinId) ||
    left.dependencyId.localeCompare(right.dependencyId) ||
    left.dependencyType.localeCompare(right.dependencyType)
  ));
}

function findReserveSlicesMissingCoinId(
  activeCoins: readonly StablecoinMeta[],
  marketCapById: ReadonlyMap<string, number> | null,
): ReserveSliceCoverageRow[] {
  const rows: ReserveSliceCoverageRow[] = [];

  activeCoins.forEach((coin, coinIndex) => {
    (coin.reserves ?? []).forEach((reserve, reserveIndex) => {
      if (reserve.coinId) return;
      rows.push({
        coinId: coin.id,
        symbol: coin.symbol,
        reserveIndex,
        reserveName: reserve.name,
        pct: reserve.pct,
        risk: reserve.risk,
        depType: reserve.depType ?? null,
        marketCapUsd: marketCapForId(marketCapById, coin.id),
        rank: coinIndex + 1,
      });
    });
  });

  return sortByMarketCapOrRank(rows);
}

function findMissingCandidates(input: {
  activeCoins: readonly StablecoinMeta[];
  graph: DependencyGraphCoverageSummary;
  marketCapById: ReadonlyMap<string, number> | null;
}): MissingDependencyCandidateRow[] {
  const participantIds = new Set(input.graph.participantIds);
  const rows = input.activeCoins.flatMap((coin, index): MissingDependencyCandidateRow[] => (
    participantIds.has(coin.id)
      ? []
      : [{
          coinId: coin.id,
          symbol: coin.symbol,
          name: coin.name,
          marketCapUsd: marketCapForId(input.marketCapById, coin.id),
          rank: index + 1,
        }]
  ));

  return sortByMarketCapOrRank(rows);
}

export function buildDependencyCoverageAudit(input: DependencyCoverageAuditInput = {}): DependencyCoverageAudit {
  const activeCoins = input.activeCoins ?? ACTIVE_STABLECOINS;
  const activeIds = new Set(activeCoins.map((coin) => coin.id));
  const marketCapById = buildMarketCapMap(input.stablecoins);
  const warnings: string[] = [];
  if (input.stablecoins !== undefined && marketCapById?.size === 0) {
    warnings.push("Stablecoin payload did not contain any pegged asset rows.");
  }

  const staticEdges = buildDependencyGraphEdges(activeCoins);
  const staticGraph = summarizeDependencyGraph(staticEdges, activeIds);

  let reportCardGraph: DependencyGraphCoverageSummary | null = null;
  if (input.reportCards !== undefined) {
    const reportCardEdges = extractReportCardEdges(input.reportCards);
    if (!reportCardEdges) {
      throw new Error("Report-card input does not contain dependencyGraph.edges.");
    }
    reportCardGraph = summarizeDependencyGraph(reportCardEdges, activeIds);
  }

  const graphForMissingCandidates = reportCardGraph ?? staticGraph;
  const missingCandidates = findMissingCandidates({
    activeCoins,
    graph: graphForMissingCandidates,
    marketCapById,
  });
  const reserveMissing = findReserveSlicesMissingCoinId(activeCoins, marketCapById);
  const depTypeWithoutCoinIdWarnings = reserveMissing.filter((row) => row.depType != null);
  const manualOnlyDependencies = findManualOnlyDependencies(activeCoins);

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    mode: input.mode ?? "static",
    summary: {
      activeCount: activeCoins.length,
      staticEdgeCount: staticGraph.edgeCount,
      staticActiveEdgeCount: staticGraph.activeEdgeCount,
      staticParticipantCount: staticGraph.participantCount,
      staticDependentCount: staticGraph.dependentCount,
      staticUpstreamOnlyCount: staticGraph.upstreamOnlyCount,
      reportCardEdgeCount: reportCardGraph?.edgeCount ?? null,
      reportCardActiveEdgeCount: reportCardGraph?.activeEdgeCount ?? null,
      reportCardParticipantCount: reportCardGraph?.participantCount ?? null,
      reportCardDependentCount: reportCardGraph?.dependentCount ?? null,
      reportCardUpstreamOnlyCount: reportCardGraph?.upstreamOnlyCount ?? null,
      manualOnlyDependencyCount: manualOnlyDependencies.length,
      reserveSlicesMissingCoinId: reserveMissing.length,
      depTypeWithoutCoinIdWarnings: depTypeWithoutCoinIdWarnings.length,
      missingCandidateCount: missingCandidates.length,
      missingCandidateRankSource: marketCapById ? "stablecoin-api-market-cap" : "local-canonical-order",
      missingCandidateGraphSource: reportCardGraph ? "report-card" : "static",
    },
    staticGraph,
    reportCardGraph,
    manualOnlyDependencies,
    reserveSlicesMissingCoinId: reserveMissing,
    depTypeWithoutCoinIdWarnings,
    highestMarketCapMissingCandidates: missingCandidates,
    warnings,
  };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatUsd(value: number | null): string {
  if (value == null) return "";
  if (value >= 1_000_000_000) return `$${formatNumber(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `$${formatNumber(value / 1_000_000)}M`;
  if (value >= 1_000) return `$${formatNumber(value / 1_000)}K`;
  return `$${formatNumber(value)}`;
}

function markdownValue(value: unknown): string {
  if (value == null || value === "") return "";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderMissingCandidates(rows: readonly MissingDependencyCandidateRow[]): string[] {
  const clipped = rows.slice(0, MISSING_CANDIDATE_LIMIT);
  if (clipped.length === 0) return ["_None._"];
  return [
    "coin | mcap | local rank",
    "--- | ---: | ---:",
    ...clipped.map((row) => [
      `${row.symbol} (${row.coinId})`,
      formatUsd(row.marketCapUsd),
      row.rank,
    ].map(markdownValue).join(" | ")),
    ...(rows.length > clipped.length ? [`_Plus ${rows.length - clipped.length} more rows._`] : []),
  ];
}

function renderReserveRows(rows: readonly ReserveSliceCoverageRow[], limit: number): string[] {
  const clipped = rows.slice(0, limit);
  if (clipped.length === 0) return ["_None._"];
  return [
    "coin | mcap | reserve index | reserve slice | pct | risk | depType",
    "--- | ---: | ---: | --- | ---: | --- | ---",
    ...clipped.map((row) => [
      `${row.symbol} (${row.coinId})`,
      formatUsd(row.marketCapUsd),
      row.reserveIndex,
      row.reserveName,
      row.pct,
      row.risk,
      row.depType,
    ].map(markdownValue).join(" | ")),
    ...(rows.length > clipped.length ? [`_Plus ${rows.length - clipped.length} more rows._`] : []),
  ];
}

function renderManualDependencyRows(rows: readonly ManualOnlyDependencyRow[]): string[] {
  const clipped = rows.slice(0, MANUAL_DEPENDENCY_LIMIT);
  if (clipped.length === 0) return ["_None._"];
  return [
    "coin | dependency | type | weight",
    "--- | --- | --- | ---:",
    ...clipped.map((row) => [
      `${row.symbol} (${row.coinId})`,
      row.dependencyId,
      row.dependencyType,
      row.weight,
    ].map(markdownValue).join(" | ")),
    ...(rows.length > clipped.length ? [`_Plus ${rows.length - clipped.length} more rows._`] : []),
  ];
}

export function renderDependencyCoverageAuditMarkdown(audit: DependencyCoverageAudit): string {
  const lines = [
    "# Dependency Coverage Audit",
    "",
    `Generated: ${audit.generatedAt}`,
    `Mode: ${audit.mode}`,
    "",
    "## Summary",
    "",
    `- Active stablecoins: ${audit.summary.activeCount}`,
    `- Static dependency edges: ${audit.summary.staticEdgeCount}`,
    `- Static active-to-active dependency edges: ${audit.summary.staticActiveEdgeCount}`,
    `- Static graph participants: ${audit.summary.staticParticipantCount}`,
    `- Static graph dependents: ${audit.summary.staticDependentCount}`,
    `- Static graph upstream-only participants: ${audit.summary.staticUpstreamOnlyCount}`,
    `- Report-card dependency edges: ${audit.summary.reportCardEdgeCount ?? "not supplied"}`,
    `- Report-card graph participants: ${audit.summary.reportCardParticipantCount ?? "not supplied"}`,
    `- Manual-only dependency entries: ${audit.summary.manualOnlyDependencyCount}`,
    `- Reserve slices missing coinId: ${audit.summary.reserveSlicesMissingCoinId}`,
    `- depType without coinId warnings: ${audit.summary.depTypeWithoutCoinIdWarnings}`,
    `- Missing graph-participant candidates: ${audit.summary.missingCandidateCount}`,
    `- Missing candidate graph source: ${audit.summary.missingCandidateGraphSource}`,
    `- Missing candidate rank source: ${audit.summary.missingCandidateRankSource}`,
    "",
    "## Highest-Market-Cap Missing Candidates",
    "",
    ...renderMissingCandidates(audit.highestMarketCapMissingCandidates),
    "",
    "## depType Without coinId Warnings",
    "",
    ...renderReserveRows(audit.depTypeWithoutCoinIdWarnings, RESERVE_SLICE_LIMIT),
    "",
    "## Manual-Only Dependencies",
    "",
    ...renderManualDependencyRows(audit.manualOnlyDependencies),
    "",
    "## Reserve Slices Missing coinId",
    "",
    ...renderReserveRows(audit.reserveSlicesMissingCoinId, RESERVE_SLICE_LIMIT),
    "",
    "## Warnings",
    "",
    ...(audit.warnings.length > 0 ? audit.warnings.map((warning) => `- ${warning}`) : ["_None._"]),
    "",
  ];

  return `${lines.join("\n").trimEnd()}\n`;
}

export function evaluateDependencyCoverageBaseline(
  audit: DependencyCoverageAudit,
  baseline: DependencyCoverageBaseline,
): string[] {
  const failures: string[] = [];
  if (baseline.staticEdgeCount != null && audit.summary.staticEdgeCount < baseline.staticEdgeCount) {
    failures.push(`static edge count regressed from ${baseline.staticEdgeCount} to ${audit.summary.staticEdgeCount}`);
  }
  if (baseline.participantCount != null && audit.summary.staticParticipantCount < baseline.participantCount) {
    failures.push(
      `static participant count regressed from ${baseline.participantCount} to ${audit.summary.staticParticipantCount}`,
    );
  }
  if (baseline.dependentCount != null && audit.summary.staticDependentCount < baseline.dependentCount) {
    failures.push(`static dependent count regressed from ${baseline.dependentCount} to ${audit.summary.staticDependentCount}`);
  }
  return failures;
}

function parseBaseline(payload: unknown): DependencyCoverageBaseline {
  if (!isRecord(payload)) throw new Error("Dependency coverage baseline must be an object.");
  return {
    staticEdgeCount: numberValue(payload.staticEdgeCount) ?? undefined,
    participantCount: numberValue(payload.participantCount) ?? undefined,
    dependentCount: numberValue(payload.dependentCount) ?? undefined,
  };
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apiBase: null,
    prod: false,
    inputDir: null,
    reportCardsPath: null,
    stablecoinsPath: null,
    format: "markdown",
    reportPath: null,
    check: false,
    baselinePath: DEFAULT_BASELINE_PATH,
    generatedAt: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--prod") {
      options.prod = true;
      continue;
    }
    if (arg === "--api-base") {
      const value = argv[i + 1];
      if (!value) throw new Error("--api-base requires a URL");
      options.apiBase = value;
      i += 1;
      continue;
    }
    if (arg === "--input") {
      const value = argv[i + 1];
      if (!value) throw new Error("--input requires a directory path");
      options.inputDir = value;
      i += 1;
      continue;
    }
    if (arg === "--report-cards") {
      const value = argv[i + 1];
      if (!value) throw new Error("--report-cards requires a file path");
      options.reportCardsPath = value;
      i += 1;
      continue;
    }
    if (arg === "--stablecoins") {
      const value = argv[i + 1];
      if (!value) throw new Error("--stablecoins requires a file path");
      options.stablecoinsPath = value;
      i += 1;
      continue;
    }
    if (arg === "--json") {
      options.format = "json";
      continue;
    }
    if (arg === "--markdown") {
      options.format = "markdown";
      continue;
    }
    if (arg === "--report") {
      const value = argv[i + 1];
      if (!value) throw new Error("--report requires a path");
      options.reportPath = value;
      i += 1;
      continue;
    }
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--baseline") {
      const value = argv[i + 1];
      if (!value) throw new Error("--baseline requires a file path");
      options.baselinePath = value;
      i += 1;
      continue;
    }
    if (arg === "--generated-at") {
      const value = argv[i + 1];
      if (!value) throw new Error("--generated-at requires an ISO timestamp or 'now'");
      options.generatedAt = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.prod && options.apiBase) {
    throw new Error("Choose only one of --prod or --api-base.");
  }

  return options;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

async function fetchJson(url: string, fetchImpl: typeof fetch, apiKey: string | undefined): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;

  const response = await fetchImpl(url, { headers });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${body.slice(0, 160)}`);
  }
  return JSON.parse(body) as unknown;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

async function loadOptionalInputs(
  options: CliOptions,
  cwd: string,
  fetchImpl: typeof fetch,
): Promise<Pick<DependencyCoverageAuditInput, "reportCards" | "stablecoins" | "mode">> {
  if (options.prod) {
    const [reportCards, stablecoins] = await Promise.all([
      fetchJson(PROD_REPORT_CARDS_URL, fetchImpl, undefined),
      fetchJson(PROD_STABLECOINS_URL, fetchImpl, undefined),
    ]);
    return { reportCards, stablecoins, mode: "prod" };
  }

  if (options.apiBase) {
    const apiKey = process.env.DEPENDENCY_COVERAGE_API_KEY ?? process.env.PHAROS_API_KEY ?? process.env.SMOKE_API_KEY;
    const [reportCards, stablecoins] = await Promise.all([
      fetchJson(joinUrl(options.apiBase, "/api/report-cards"), fetchImpl, apiKey),
      fetchJson(joinUrl(options.apiBase, "/api/stablecoins"), fetchImpl, apiKey),
    ]);
    return { reportCards, stablecoins, mode: "api" };
  }

  const inputDir = options.inputDir ? resolve(cwd, options.inputDir) : null;
  const reportCardsPath = options.reportCardsPath
    ? resolve(cwd, options.reportCardsPath)
    : inputDir
      ? resolve(inputDir, "report-cards.json")
      : null;
  const stablecoinsPath = options.stablecoinsPath
    ? resolve(cwd, options.stablecoinsPath)
    : inputDir
      ? resolve(inputDir, "stablecoins.json")
      : null;

  return {
    reportCards: reportCardsPath && existsSync(reportCardsPath) ? readJsonFile(reportCardsPath) : undefined,
    stablecoins: stablecoinsPath && existsSync(stablecoinsPath) ? readJsonFile(stablecoinsPath) : undefined,
    mode: reportCardsPath || stablecoinsPath ? "input" : "static",
  };
}

function resolveGeneratedAt(options: CliOptions): string {
  if (options.generatedAt === "now") return new Date().toISOString();
  return options.generatedAt ?? new Date().toISOString();
}

function writeOutput(path: string, output: string, cwd: string): void {
  const target = resolve(cwd, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, output, "utf8");
  process.stdout.write(`Wrote dependency coverage audit to ${target}\n`);
}

function readBaseline(path: string, cwd: string): DependencyCoverageBaseline | null {
  const target = resolve(cwd, path);
  if (!existsSync(target)) return null;
  return parseBaseline(readJsonFile(target));
}

export async function runCli(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const options = parseArgs(argv);
  const loaded = await loadOptionalInputs(options, cwd, fetchImpl);
  const audit = buildDependencyCoverageAudit({
    ...loaded,
    generatedAt: resolveGeneratedAt(options),
  });
  const output = options.format === "json"
    ? `${JSON.stringify(audit, null, 2)}\n`
    : renderDependencyCoverageAuditMarkdown(audit);

  if (options.reportPath) {
    writeOutput(options.reportPath, output, cwd);
  } else {
    process.stdout.write(output);
  }

  if (!options.check) return 0;

  const baseline = readBaseline(options.baselinePath, cwd);
  if (!baseline) {
    process.stdout.write(
      `Dependency coverage check: no baseline at ${options.baselinePath}; advisory audit only.\n`,
    );
    return 0;
  }

  const failures = evaluateDependencyCoverageBaseline(audit, baseline);
  if (failures.length === 0) {
    process.stdout.write("Dependency coverage check: OK\n");
    return 0;
  }

  process.stderr.write(`Dependency coverage check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  return 1;
}

if (process.argv[1]?.endsWith("generate-dependency-coverage-audit.ts")) {
  runCli().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
