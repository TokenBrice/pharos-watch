import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getCirculatingRaw } from "../../shared/lib/supply";

export const PROD_ORIGIN = "https://pharos.watch";
export const PROD_REPORT_CARDS_URL = `${PROD_ORIGIN}/_site-data/report-cards`;
export const PROD_STABLECOINS_URL = `${PROD_ORIGIN}/_site-data/stablecoins`;

export interface UnknownRecord {
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

export function writeOutputFile(path: string, contents: string, cwd: string = process.cwd()): string {
  const target = resolve(cwd, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
  return target;
}
