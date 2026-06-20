import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getCirculatingRaw } from "../../shared/lib/supply";
import { isRecord, numberValue, stringValue } from "@shared/lib/type-guards";

export { isRecord, numberValue, stringValue };

export const PROD_ORIGIN = "https://pharos.watch";
export const PROD_REPORT_CARDS_URL = `${PROD_ORIGIN}/_site-data/report-cards`;
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
      fetchJson(joinUrl(options.apiBase, "/api/report-cards"), fetchImpl, apiKey),
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
  if (!process.argv[1] || importMetaUrl !== pathToFileURL(resolve(process.argv[1])).href) return;

  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
