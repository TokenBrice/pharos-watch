#!/usr/bin/env tsx

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "../../shared/lib/live-reserve-adapters-definitions";
import {
  ACTIVE_STABLECOINS,
  FROZEN_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
  TRACKED_STABLECOINS,
} from "../../shared/lib/stablecoins/registry";
import type { LiveReserveEvidenceClass } from "../../shared/types/live-reserves";
import type { ReserveSlice, StablecoinMeta } from "../../shared/types";

const PROD_ORIGIN = "https://pharos.watch";
const PROD_REPORT_CARDS_URL = `${PROD_ORIGIN}/_site-data/report-cards`;
const SCORE_GRADE_GAP_LIMIT = 50;

interface UnknownRecord {
  [key: string]: unknown;
}

export interface ReserveCoverageAuditInput {
  trackedCoins?: readonly StablecoinMeta[];
  activeCoins?: readonly StablecoinMeta[];
  preLaunchCoins?: readonly StablecoinMeta[];
  frozenCoins?: readonly StablecoinMeta[];
  reportCards?: unknown;
  generatedAt?: string;
  mode?: "static" | "input" | "api" | "prod";
}

export interface ReserveCoverageAudit {
  generatedAt: string;
  mode: "static" | "input" | "api" | "prod";
  summary: {
    trackedCount: number;
    activeCount: number;
    preLaunchCount: number;
    frozenCount: number;
    activeWithCuratedReserves: number;
    activeReserveSliceCount: number;
    activeLinkedReserveSliceCount: number;
    activeUnlinkedReserveSliceCount: number;
    activeUnlinkedReserveSlicePctGte10Count: number;
    activeUnlinkedReserveSlicePctGte50Count: number;
    activeWithLinkedReserveSliceCount: number;
    liveEnabledActiveCount: number;
    reportCardActiveCount: number | null;
    collateralFromLiveActiveCount: number | null;
    dependencyFromLiveActiveCount: number | null;
    independentConfiguredButNotScoreGradeCount: number | null;
  };
  liveEnabledByEvidenceClass: Record<LiveReserveEvidenceClass, number>;
  independentConfiguredButNotScoreGradeIds: string[] | null;
  warnings: string[];
}

interface CliOptions {
  prod: boolean;
  apiBase: string | null;
  reportCardsPath: string | null;
  format: "markdown" | "json";
  reportPath: string | null;
  generatedAt: string | null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boolValue(value: unknown): boolean {
  return value === true;
}

function extractReportCardRows(payload: unknown): UnknownRecord[] | null {
  const envelope = isRecord(payload) && isRecord(payload.payload) ? payload.payload : payload;
  if (!isRecord(envelope) || !Array.isArray(envelope.cards)) return null;
  return envelope.cards.filter(isRecord);
}

function reserveSlicesFor(coin: StablecoinMeta): readonly ReserveSlice[] {
  return coin.reserves ?? [];
}

function evidenceClassForCoin(coin: StablecoinMeta): LiveReserveEvidenceClass | null {
  const adapter = coin.liveReservesConfig?.adapter;
  if (!adapter) return null;
  return LIVE_RESERVE_ADAPTER_DEFINITIONS[adapter]?.evidenceClass ?? null;
}

function emptyEvidenceClassCounts(): Record<LiveReserveEvidenceClass, number> {
  return {
    independent: 0,
    "static-validated": 0,
    "weak-live-probe": 0,
  };
}

function summarizeReportCards(
  payload: unknown,
  activeIds: ReadonlySet<string>,
): Pick<
  ReserveCoverageAudit["summary"],
  | "reportCardActiveCount"
  | "collateralFromLiveActiveCount"
  | "dependencyFromLiveActiveCount"
> & { collateralFromLiveIds: Set<string> } {
  const rows = extractReportCardRows(payload);
  if (!rows) {
    throw new Error("Report-card input does not contain cards[].");
  }

  const activeRows = rows.filter((row) => {
    const id = stringValue(row.id);
    return id != null && activeIds.has(id);
  });
  const collateralFromLiveIds = new Set<string>();
  let dependencyFromLiveActiveCount = 0;

  for (const row of activeRows) {
    const id = stringValue(row.id);
    const rawInputs = isRecord(row.rawInputs) ? row.rawInputs : {};
    if (id && boolValue(rawInputs.collateralFromLive)) {
      collateralFromLiveIds.add(id);
    }
    if (boolValue(rawInputs.dependencyFromLive)) {
      dependencyFromLiveActiveCount += 1;
    }
  }

  return {
    reportCardActiveCount: activeRows.length,
    collateralFromLiveActiveCount: collateralFromLiveIds.size,
    dependencyFromLiveActiveCount,
    collateralFromLiveIds,
  };
}

export function buildReserveCoverageAudit(input: ReserveCoverageAuditInput = {}): ReserveCoverageAudit {
  const trackedCoins = input.trackedCoins ?? TRACKED_STABLECOINS;
  const activeCoins = input.activeCoins ?? ACTIVE_STABLECOINS;
  const preLaunchCoins = input.preLaunchCoins ?? PRE_LAUNCH_STABLECOINS;
  const frozenCoins = input.frozenCoins ?? FROZEN_STABLECOINS;
  const activeIds = new Set(activeCoins.map((coin) => coin.id));
  const warnings: string[] = [];
  const liveEnabledByEvidenceClass = emptyEvidenceClassCounts();

  let activeReserveSliceCount = 0;
  let activeLinkedReserveSliceCount = 0;
  let activeUnlinkedReserveSliceCount = 0;
  let activeUnlinkedReserveSlicePctGte10Count = 0;
  let activeUnlinkedReserveSlicePctGte50Count = 0;
  let activeWithLinkedReserveSliceCount = 0;
  let liveEnabledActiveCount = 0;
  const independentConfiguredIds: string[] = [];

  for (const coin of activeCoins) {
    const reserves = reserveSlicesFor(coin);
    activeReserveSliceCount += reserves.length;
    if (reserves.some((reserve) => reserve.coinId)) {
      activeWithLinkedReserveSliceCount += 1;
    }

    for (const reserve of reserves) {
      if (reserve.coinId) {
        activeLinkedReserveSliceCount += 1;
      } else {
        activeUnlinkedReserveSliceCount += 1;
        if (reserve.pct >= 10) activeUnlinkedReserveSlicePctGte10Count += 1;
        if (reserve.pct >= 50) activeUnlinkedReserveSlicePctGte50Count += 1;
      }
    }

    const evidenceClass = evidenceClassForCoin(coin);
    if (evidenceClass) {
      liveEnabledActiveCount += 1;
      liveEnabledByEvidenceClass[evidenceClass] += 1;
      if (evidenceClass === "independent") independentConfiguredIds.push(coin.id);
    } else if (coin.liveReservesConfig?.adapter) {
      warnings.push(`Unknown live reserve adapter for ${coin.id}: ${coin.liveReservesConfig.adapter}`);
    }
  }

  let reportCardActiveCount: number | null = null;
  let collateralFromLiveActiveCount: number | null = null;
  let dependencyFromLiveActiveCount: number | null = null;
  let independentConfiguredButNotScoreGradeIds: string[] | null = null;
  if (input.reportCards !== undefined) {
    const reportCardSummary = summarizeReportCards(input.reportCards, activeIds);
    reportCardActiveCount = reportCardSummary.reportCardActiveCount;
    collateralFromLiveActiveCount = reportCardSummary.collateralFromLiveActiveCount;
    dependencyFromLiveActiveCount = reportCardSummary.dependencyFromLiveActiveCount;
    independentConfiguredButNotScoreGradeIds = independentConfiguredIds
      .filter((id) => !reportCardSummary.collateralFromLiveIds.has(id))
      .sort();
  }

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    mode: input.mode ?? (input.reportCards === undefined ? "static" : "input"),
    summary: {
      trackedCount: trackedCoins.length,
      activeCount: activeCoins.length,
      preLaunchCount: preLaunchCoins.length,
      frozenCount: frozenCoins.length,
      activeWithCuratedReserves: activeCoins.filter((coin) => reserveSlicesFor(coin).length > 0).length,
      activeReserveSliceCount,
      activeLinkedReserveSliceCount,
      activeUnlinkedReserveSliceCount,
      activeUnlinkedReserveSlicePctGte10Count,
      activeUnlinkedReserveSlicePctGte50Count,
      activeWithLinkedReserveSliceCount,
      liveEnabledActiveCount,
      reportCardActiveCount,
      collateralFromLiveActiveCount,
      dependencyFromLiveActiveCount,
      independentConfiguredButNotScoreGradeCount: independentConfiguredButNotScoreGradeIds?.length ?? null,
    },
    liveEnabledByEvidenceClass,
    independentConfiguredButNotScoreGradeIds,
    warnings,
  };
}

function renderNullableCount(value: number | null): string {
  return value == null ? "not supplied" : String(value);
}

export function renderReserveCoverageAuditMarkdown(audit: ReserveCoverageAudit): string {
  const clippedGaps = (audit.independentConfiguredButNotScoreGradeIds ?? []).slice(0, SCORE_GRADE_GAP_LIMIT);
  const lines = [
    "# Reserve Coverage Audit",
    "",
    `Generated: ${audit.generatedAt}`,
    `Mode: ${audit.mode}`,
    "",
    "## Summary",
    "",
    `- Tracked stablecoins: ${audit.summary.trackedCount}`,
    `- Active stablecoins: ${audit.summary.activeCount}`,
    `- Pre-launch stablecoins: ${audit.summary.preLaunchCount}`,
    `- Frozen stablecoins: ${audit.summary.frozenCount}`,
    `- Active coins with curated reserves: ${audit.summary.activeWithCuratedReserves}`,
    `- Active reserve slices: ${audit.summary.activeReserveSliceCount}`,
    `- Active linked reserve slices: ${audit.summary.activeLinkedReserveSliceCount}`,
    `- Active unlinked reserve slices: ${audit.summary.activeUnlinkedReserveSliceCount}`,
    `- Active unlinked reserve slices >=10%: ${audit.summary.activeUnlinkedReserveSlicePctGte10Count}`,
    `- Active unlinked reserve slices >=50%: ${audit.summary.activeUnlinkedReserveSlicePctGte50Count}`,
    `- Active coins with at least one linked reserve slice: ${audit.summary.activeWithLinkedReserveSliceCount}`,
    `- Live-enabled active coins: ${audit.summary.liveEnabledActiveCount}`,
    `- Live-enabled independent: ${audit.liveEnabledByEvidenceClass.independent}`,
    `- Live-enabled static-validated: ${audit.liveEnabledByEvidenceClass["static-validated"]}`,
    `- Live-enabled weak-live-probe: ${audit.liveEnabledByEvidenceClass["weak-live-probe"]}`,
    `- Report-card active cards: ${renderNullableCount(audit.summary.reportCardActiveCount)}`,
    `- Active collateralFromLive cards: ${renderNullableCount(audit.summary.collateralFromLiveActiveCount)}`,
    `- Active dependencyFromLive cards: ${renderNullableCount(audit.summary.dependencyFromLiveActiveCount)}`,
    `- Independent configured but not score-grade: ${
      renderNullableCount(audit.summary.independentConfiguredButNotScoreGradeCount)
    }`,
    "",
    "## Independent Configured But Not Score-Grade",
    "",
    audit.independentConfiguredButNotScoreGradeIds == null
      ? "_Report-card snapshot not supplied._"
      : clippedGaps.length === 0
        ? "_None._"
        : clippedGaps.map((id) => `- ${id}`).join("\n"),
    ...(audit.independentConfiguredButNotScoreGradeIds != null
        && audit.independentConfiguredButNotScoreGradeIds.length > clippedGaps.length
      ? [`_Plus ${audit.independentConfiguredButNotScoreGradeIds.length - clippedGaps.length} more IDs._`]
      : []),
    "",
    "## Warnings",
    "",
    ...(audit.warnings.length > 0 ? audit.warnings.map((warning) => `- ${warning}`) : ["_None._"]),
    "",
  ];

  return `${lines.flat().join("\n").trimEnd()}\n`;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    prod: false,
    apiBase: null,
    reportCardsPath: null,
    format: "markdown",
    reportPath: null,
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
    if (arg === "--report-cards") {
      const value = argv[i + 1];
      if (!value) throw new Error("--report-cards requires a file path");
      options.reportCardsPath = value;
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
  if ((options.prod || options.apiBase) && options.reportCardsPath) {
    throw new Error("Choose a fetched report-card source or --report-cards, not both.");
  }

  return options;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  apiKey: string | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json", ...extraHeaders };
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

async function loadReportCardInput(
  options: CliOptions,
  cwd: string,
  fetchImpl: typeof fetch,
): Promise<Pick<ReserveCoverageAuditInput, "reportCards" | "mode">> {
  if (options.prod) {
    const reportCards = await fetchJson(PROD_REPORT_CARDS_URL, fetchImpl, undefined, {
      Origin: PROD_ORIGIN,
      Referer: `${PROD_ORIGIN}/coverage/`,
    });
    return { reportCards, mode: "prod" };
  }

  if (options.apiBase) {
    const apiKey = process.env.RESERVE_COVERAGE_API_KEY ?? process.env.PHAROS_API_KEY ?? process.env.SMOKE_API_KEY;
    const reportCards = await fetchJson(joinUrl(options.apiBase, "/api/report-cards"), fetchImpl, apiKey);
    return { reportCards, mode: "api" };
  }

  if (options.reportCardsPath) {
    const target = resolve(cwd, options.reportCardsPath);
    if (!existsSync(target)) {
      throw new Error(`--report-cards file not found: ${target}`);
    }
    return { reportCards: readJsonFile(target), mode: "input" };
  }

  return { mode: "static" };
}

function resolveGeneratedAt(options: CliOptions): string {
  if (options.generatedAt === "now") return new Date().toISOString();
  return options.generatedAt ?? new Date().toISOString();
}

function writeOutput(path: string, output: string, cwd: string): void {
  const target = resolve(cwd, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, output, "utf8");
  process.stdout.write(`Wrote reserve coverage audit to ${target}\n`);
}

export async function runCli(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const options = parseArgs(argv);
  const loaded = await loadReportCardInput(options, cwd, fetchImpl);
  const audit = buildReserveCoverageAudit({
    ...loaded,
    generatedAt: resolveGeneratedAt(options),
  });
  const output = options.format === "json"
    ? `${JSON.stringify(audit, null, 2)}\n`
    : renderReserveCoverageAuditMarkdown(audit);

  if (options.reportPath) {
    writeOutput(options.reportPath, output, cwd);
  } else {
    process.stdout.write(output);
  }

  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().then((code) => process.exit(code)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
