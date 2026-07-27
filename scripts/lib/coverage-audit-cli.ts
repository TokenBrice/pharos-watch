import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { getCirculatingRaw } from "../../shared/lib/supply";
import { isRecord, numberValue, stringValue } from "@shared/lib/type-guards";
import { isDirectRun } from "./smoke-runtime.mjs";

export { isRecord, numberValue, stringValue };

export const PROD_ORIGIN = "https://pharos.watch";
export const PROD_REPORT_CARDS_URL = `${PROD_ORIGIN}/_site-data/report-cards/v9`;
export const PROD_STABLECOINS_URL = `${PROD_ORIGIN}/_site-data/stablecoins`;

export interface UnknownRecord {
  [key: string]: unknown;
}

export function extractStablecoinRows(payload: unknown): UnknownRecord[] {
  const envelope = isRecord(payload) && isRecord(payload.payload) ? payload.payload : payload;
  const rows = Array.isArray(envelope)
    ? envelope
    : isRecord(envelope) && Array.isArray(envelope.peggedAssets)
      ? envelope.peggedAssets
      : [];
  return rows.filter(isRecord);
}

export function marketCapForStablecoinRow(row: UnknownRecord): number {
  const direct = numberValue(row.marketCapUsd ?? row.marketCap ?? row.mcapUsd);
  if (direct != null) return direct;
  return getCirculatingRaw(row as { circulating?: Record<string, number> | null | undefined });
}

export function sortByMarketCapOrRank<T extends { marketCapUsd: number | null; rank: number; coinId: string }>(
  rows: T[],
): T[] {
  return rows.sort((left, right) => {
    if (left.marketCapUsd != null || right.marketCapUsd != null) {
      return (right.marketCapUsd ?? -1) - (left.marketCapUsd ?? -1) || left.coinId.localeCompare(right.coinId);
    }
    return left.rank - right.rank || left.coinId.localeCompare(right.coinId);
  });
}

export function toPositiveInt(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

export function resolveSelectedStablecoins<T>(
  coinIds: readonly string[],
  activeMetaById: ReadonlyMap<string, T>,
  activeStablecoins: readonly T[],
): T[] {
  if (coinIds.length > 0) {
    return coinIds.map((id) => {
      const coin = activeMetaById.get(id);
      if (!coin) throw new Error(`Unknown active stablecoin ID: ${id}`);
      return coin;
    });
  }
  return [...activeStablecoins];
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

export function formatUsd(value: number | null): string {
  if (value == null) return "";
  if (value >= 1_000_000_000) return `$${formatNumber(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `$${formatNumber(value / 1_000_000)}M`;
  if (value >= 1_000) return `$${formatNumber(value / 1_000)}K`;
  return `$${formatNumber(value)}`;
}

export function markdownValue(value: unknown): string {
  if (value == null || value === "") return "";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export async function fetchJson(
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

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

export function readRequiredJsonFile(path: string, label: string): unknown {
  if (!existsSync(path)) {
    throw new Error(`${label} file not found: ${path}`);
  }
  return readJsonFile(path);
}

export function resolveGeneratedAt(options: { generatedAt: string | null }): string {
  if (options.generatedAt === "now") return new Date().toISOString();
  return options.generatedAt ?? new Date().toISOString();
}

export type CoverageAuditReportFormat = "markdown" | "json";

export interface CandidateReportCliOptions {
  coinIds: string[];
  limit: number;
  all: boolean;
  format: CoverageAuditReportFormat;
  reportPath: string | null;
  stdout: boolean;
  generatedAt: string | null;
}

export function createCandidateReportCliOptions({
  defaultLimit,
  defaultOutputPath,
}: {
  defaultLimit: number;
  defaultOutputPath: string;
}): CandidateReportCliOptions {
  return {
    coinIds: [],
    limit: defaultLimit,
    all: false,
    format: "markdown",
    reportPath: defaultOutputPath,
    stdout: false,
    generatedAt: null,
  };
}

export function parseCandidateReportOption(
  options: CandidateReportCliOptions,
  argv: readonly string[],
  index: number,
  {
    usage,
  }: {
    usage: () => string;
  },
): number | null {
  const arg = argv[index];
  if (arg === "--coin") {
    const value = argv[index + 1];
    if (!value) throw new Error("--coin requires a stablecoin ID");
    options.coinIds.push(value);
    return index + 1;
  }
  if (arg === "--limit") {
    options.limit = toPositiveInt(argv[index + 1] ?? "", "--limit");
    return index + 1;
  }
  if (arg === "--all") {
    options.all = true;
    return index;
  }
  if (arg === "--json") {
    options.format = "json";
    return index;
  }
  if (arg === "--markdown") {
    options.format = "markdown";
    return index;
  }
  if (arg === "--report") {
    const value = argv[index + 1];
    if (!value) throw new Error("--report requires a path");
    options.reportPath = value;
    return index + 1;
  }
  if (arg === "--stdout") {
    options.stdout = true;
    return index;
  }
  if (arg === "--generated-at") {
    const value = argv[index + 1];
    if (!value) throw new Error("--generated-at requires an ISO timestamp");
    options.generatedAt = value;
    return index + 1;
  }
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  return null;
}

export function assertCandidateReportLimitChoice(
  options: Pick<CandidateReportCliOptions, "all" | "limit">,
  defaultLimit: number,
): void {
  if (options.all && options.limit !== defaultLimit) {
    throw new Error("Choose either --all or --limit, not both.");
  }
}

export function renderCoverageAuditReport<T>(
  audit: T,
  format: CoverageAuditReportFormat,
  renderMarkdown: (audit: T) => string,
): string {
  return format === "json" ? `${JSON.stringify(audit, null, 2)}\n` : renderMarkdown(audit);
}

export function writeCandidateReportCliOutput({
  options,
  output,
  cwd,
  stdout,
  protectedRoot,
  protectedMessage,
  missingMessage,
  writtenMessage,
}: {
  options: Pick<CandidateReportCliOptions, "stdout" | "reportPath">;
  output: string;
  cwd: string;
  stdout: Pick<NodeJS.WriteStream, "write">;
  protectedRoot: string;
  protectedMessage: string;
  missingMessage: (target: string) => string;
  writtenMessage: (target: string) => string;
}): void {
  if (options.stdout || !options.reportPath) {
    stdout.write(output);
    return;
  }

  const target = writeAdvisoryReport(cwd, options.reportPath, output, {
    protectedRoot,
    message: protectedMessage,
  });
  if (!existsSync(target)) {
    throw new Error(missingMessage(target));
  }
  stdout.write(`${writtenMessage(target)}\n`);
}

export async function loadCoverageAuditSiteDataInputs(
  options: { prod: boolean; apiBase: string | null; apiKeyEnv: string },
  fetchImpl: typeof fetch,
): Promise<{ reportCards: unknown; stablecoins: unknown; mode: "prod" | "api" } | null> {
  if (options.prod) {
    const siteDataHeaders = {
      Origin: PROD_ORIGIN,
      Referer: `${PROD_ORIGIN}/coverage/`,
    };
    const [reportCards, stablecoins] = await Promise.all([
      fetchJson(PROD_REPORT_CARDS_URL, fetchImpl, undefined, siteDataHeaders),
      fetchJson(PROD_STABLECOINS_URL, fetchImpl, undefined, siteDataHeaders),
    ]);
    return { reportCards, stablecoins, mode: "prod" };
  }

  if (options.apiBase) {
    const apiKey = process.env[options.apiKeyEnv] ?? process.env.PHAROS_API_KEY ?? process.env.SMOKE_API_KEY;
    const [reportCards, stablecoins] = await Promise.all([
      fetchJson(joinUrl(options.apiBase, "/api/report-cards/v9"), fetchImpl, apiKey),
      fetchJson(joinUrl(options.apiBase, "/api/stablecoins"), fetchImpl, apiKey),
    ]);
    return { reportCards, stablecoins, mode: "api" };
  }

  return null;
}

export function buildMarketCapMapFromStablecoins(
  stablecoinsPayload: unknown | undefined,
  { trimId = true }: { trimId?: boolean } = {},
): Map<string, number> | null {
  if (stablecoinsPayload === undefined) return null;

  const map = new Map<string, number>();
  for (const row of extractStablecoinRows(stablecoinsPayload)) {
    const id = stringValue(row.id, { trim: trimId });
    if (!id) continue;
    map.set(id, marketCapForStablecoinRow(row));
  }
  return map;
}

export function writeOutputFile(path: string, contents: string, cwd: string = process.cwd()): string {
  const target = resolve(cwd, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
  return target;
}

export function assertAdvisoryReportPath(
  cwd: string,
  reportPath: string,
  protectedRoot: string,
  message: string,
): string {
  const target = resolve(cwd, reportPath);
  const pathFromProtectedRoot = relative(protectedRoot, target);
  const isProtectedPath =
    pathFromProtectedRoot === "" ||
    (!!pathFromProtectedRoot &&
      !pathFromProtectedRoot.startsWith("..") &&
      !isAbsolute(pathFromProtectedRoot));

  if (isProtectedPath) {
    throw new Error(message);
  }
  return target;
}

export function writeAdvisoryReport(
  cwd: string,
  reportPath: string,
  contents: string,
  options: { protectedRoot: string; message: string },
): string {
  const target = assertAdvisoryReportPath(cwd, reportPath, options.protectedRoot, options.message);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
  return target;
}

export function runAsMain(importMetaUrl: string, runCli: () => Promise<number>): void {
  if (!isDirectRun(importMetaUrl, process.argv[1])) return;

  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
