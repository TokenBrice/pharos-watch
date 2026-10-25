#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import { API_ORIGIN, PAGES_APP_ORIGIN, SITE_API_ORIGIN } from "@shared/lib/runtime-origins";
import { SITE_DATA_PATH_PREFIX } from "@shared/lib/site-data-lane";
import {
  detailSnapshotSourceUpdatedAt,
} from "@shared/lib/detail-snapshot-inputs";
import { DETAIL_SNAPSHOT_INPUT_BATCH_SIZE, DetailSnapshotInputsResponseSchema, type DetailSnapshotInputEntry } from "@shared/types/detail-snapshot-inputs";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  StablecoinDetailResponseSchema,
  SupplyHistoryResponseSchema,
  type SupplyHistoryPoint,
} from "@shared/types/market";
import type { StablecoinDetailSnapshot } from "../../src/lib/api";
import { normalizeStablecoinLiveSummary, projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import { StablecoinLiveSummarySchema, type StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";
import { STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS } from "../../src/lib/api-query-descriptors";
import { getScoresLatestSnapshotRow, type ScoresLatestSnapshotRow } from "../../src/lib/safety-grade-snapshot";
import {
  fetchWithRetry,
  generatorFetchHeaders,
  resolveApiPathUrl,
  resolveGeneratorApiBase,
} from "../lib/sync-from-api";
import { runDirectCli } from "../lib/cli-args.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DETAIL_SNAPSHOT_OUTPUT_DIR = resolve(REPO_ROOT, "src/generated/stablecoin-detail-snapshots");
export const DETAIL_SNAPSHOT_TARGET_BYTES = 8 * 1024;
const MAX_PARALLEL_COIN_REQUESTS = 6;
// Match the six-connection budget; bulk bodies finish before fallback reads begin.
const MAX_PARALLEL_BULK_REQUESTS = 6;
// This is the UI stale band, not the endpoint's much stricter advisory budget.
export const DETAIL_SNAPSHOT_UI_STALE_AFTER_MS =
  API_FRESHNESS_MAX_AGE_SEC.stablecoins * FRESHNESS_RATIOS.DEGRADED * 1000;
export const DETAIL_SNAPSHOT_STALE_REFRESH_LIMIT = 24;

export function selectStaleDetailSnapshotRefreshIds(
  entries: readonly DetailSnapshotInputEntry[],
  assessedAt: number,
  limit = DETAIL_SNAPSHOT_STALE_REFRESH_LIMIT,
): string[] {
  if (!Number.isInteger(limit) || limit < 0 || limit > DETAIL_SNAPSHOT_STALE_REFRESH_LIMIT) {
    throw new Error(`Detail snapshot stale refresh limit must be an integer from 0 to ${DETAIL_SNAPSHOT_STALE_REFRESH_LIMIT}`);
  }
  return entries
    .filter((entry): entry is Extract<DetailSnapshotInputEntry, { status: "available" }> =>
      entry.status === "available" && assessedAt - entry.updatedAt.liveSummary > DETAIL_SNAPSHOT_UI_STALE_AFTER_MS)
    .sort((left, right) => left.updatedAt.liveSummary - right.updatedAt.liveSummary || left.id.localeCompare(right.id))
    .slice(0, limit)
    .map((entry) => entry.id);
}

/** Only emitted detail-summary lanes enter these statistics, never artifact clocks. */
export function reportSnapshotProducerAges(
  snapshots: readonly StablecoinDetailSnapshot[],
  assessedAt = Date.now(),
): string {
  const clocks = snapshots.filter((snapshot) => snapshot.lanes.liveSummary != null)
    .map((snapshot) => snapshot.updatedAt?.liveSummary);
  const validClocks = clocks.filter((clock): clock is number =>
    clock != null && Number.isFinite(clock) && clock > 0 && clock <= assessedAt);
  const ages = validClocks.map((clock) => assessedAt - clock).sort((left, right) => left - right);
  const percentile = (ratio: number): string => ages.length
    ? `${(ages[Math.ceil(ages.length * ratio) - 1] / 60_000).toFixed(1)} min`
    : "unavailable";
  return `Detail snapshot producer age (liveSummary; assessedAt=${new Date(assessedAt).toISOString()}; ` +
    `oldestProducerAt=${validClocks.length ? new Date(Math.min(...validClocks)).toISOString() : "unavailable"}): ` +
    `max=${percentile(1)}, p50=${percentile(0.5)}, p95=${percentile(0.95)}; ` +
    `above UI stale budget ${DETAIL_SNAPSHOT_UI_STALE_AFTER_MS / 60_000} min: ` +
    `${ages.filter((age) => age > DETAIL_SNAPSHOT_UI_STALE_AFTER_MS).length}/${ages.length}; ` +
    `unavailable clocks=${clocks.length - ages.length}; no summary lane=${snapshots.length - clocks.length}`;
}

export class DetailSnapshotHttpError extends Error {
  readonly status: number;

  constructor(url: string, status: number, body: string) {
    super(`Failed to fetch ${url}: HTTP ${status}${body ? ` (${body.slice(0, 160)})` : ""}`);
    this.name = "DetailSnapshotHttpError";
    this.status = status;
  }
}

export interface SnapshotInputs {
  generatedAt: number;
  liveSummariesById: ReadonlyMap<string, StablecoinLiveSummary | null>;
  supplyHistoryById: ReadonlyMap<string, SupplyHistoryPoint[] | null>;
  updatedAtById: ReadonlyMap<string, StablecoinDetailSnapshot["updatedAt"]>;
  /** The release's committed scores-latest rows; defaults to the current mirror. */
  readScoresLatestRow?: (id: string) => ScoresLatestSnapshotRow | null;
}

export function buildStablecoinDetailSnapshots(inputs: SnapshotInputs): StablecoinDetailSnapshot[] {
  const readScoresLatestRow = inputs.readScoresLatestRow ?? getScoresLatestSnapshotRow;
  return TRACKED_STABLECOINS.map((coin) => {
    const liveSummary = inputs.liveSummariesById.get(coin.id);
    const supplyHistory = inputs.supplyHistoryById.get(coin.id);
    const snapshot: StablecoinDetailSnapshot = {
      version: 1,
      stablecoinId: coin.id,
      generatedAt: inputs.generatedAt,
      updatedAt: inputs.updatedAtById.get(coin.id) ?? {},
      lanes: {
        ...(liveSummary ? { liveSummary } : {}),
        ...(supplyHistory ? { supplyHistory } : {}),
      },
    };
    let cappedSnapshot = snapshot;
    let snapshotBytes = serializedSnapshotBytes(cappedSnapshot);
    if (snapshotBytes > DETAIL_SNAPSHOT_TARGET_BYTES && cappedSnapshot.lanes.supplyHistory) {
      const { supplyHistory: _oversizedSupplyHistory, ...lanes } = cappedSnapshot.lanes;
      console.warn(
        `[stablecoin-detail-snapshots] Omitting supply history for ${coin.id}: ` +
        `${snapshotBytes} byte envelope exceeds the 8 KiB target`,
      );
      cappedSnapshot = { ...cappedSnapshot, lanes };
      snapshotBytes = serializedSnapshotBytes(cappedSnapshot);
    }
    if (snapshotBytes > DETAIL_SNAPSHOT_TARGET_BYTES && cappedSnapshot.lanes.liveSummary) {
      const { liveSummary: _oversizedLiveSummary, ...lanes } = cappedSnapshot.lanes;
      console.warn(
        `[stablecoin-detail-snapshots] Omitting live summary for ${coin.id}: ` +
        `${snapshotBytes} byte envelope still exceeds the 8 KiB target`,
      );
      cappedSnapshot = { ...cappedSnapshot, lanes };
      snapshotBytes = serializedSnapshotBytes(cappedSnapshot);
    }
    if (snapshotBytes > DETAIL_SNAPSHOT_TARGET_BYTES) {
      throw new Error(
        `[stablecoin-detail-snapshots] Empty envelope for ${coin.id} is ${snapshotBytes} bytes; ` +
        "cannot satisfy the 8 KiB hard cap",
      );
    }
    // Display-only release values, dated by the dataset clock; never a query
    // seed. They never displace a live lane (the dossier needs both to leave
    // its loading state), so they join only the capped envelope.
    const scoresRow = readScoresLatestRow(coin.id);
    if (scoresRow) {
      const { asOfMs, ...safetyAssessment } = scoresRow;
      const withAssessment: StablecoinDetailSnapshot = {
        ...cappedSnapshot,
        updatedAt: { ...cappedSnapshot.updatedAt, safetyAssessment: asOfMs },
        lanes: { ...cappedSnapshot.lanes, safetyAssessment },
      };
      const withAssessmentBytes = serializedSnapshotBytes(withAssessment);
      if (withAssessmentBytes <= DETAIL_SNAPSHOT_TARGET_BYTES) return withAssessment;
      console.warn(
        `[stablecoin-detail-snapshots] Omitting saved safety assessment for ${coin.id}: ` +
        `${withAssessmentBytes} byte envelope exceeds the 8 KiB target`,
      );
    }
    return cappedSnapshot;
  });
}

export function serializedSnapshotBytes(snapshot: StablecoinDetailSnapshot): number {
  return Buffer.byteLength(`${JSON.stringify(snapshot)}\n`);
}

export function validateStablecoinDetailSnapshot(snapshot: unknown): StablecoinDetailSnapshot {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Detail snapshot must be an object");
  }
  const candidate = snapshot as Partial<StablecoinDetailSnapshot>;
  if (candidate.version !== 1 || typeof candidate.stablecoinId !== "string" ||
      typeof candidate.generatedAt !== "number" || !Number.isFinite(candidate.generatedAt) ||
      !candidate.lanes || typeof candidate.lanes !== "object") {
    throw new Error("Detail snapshot header is invalid");
  }
  if (candidate.lanes.liveSummary) StablecoinLiveSummarySchema.parse(candidate.lanes.liveSummary);
  if (candidate.lanes.supplyHistory) SupplyHistoryResponseSchema.parse(candidate.lanes.supplyHistory);
  if (candidate.lanes.safetyAssessment) {
    const assessment = candidate.lanes.safetyAssessment;
    const nullableNumber = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value));
    if (!nullableNumber(assessment.score) || !nullableNumber(assessment.dewsScore)
      || !nullableNumber(assessment.liquidityScore)
      || (assessment.grade !== null && typeof assessment.grade !== "string")
      || (assessment.dewsBand !== null && typeof assessment.dewsBand !== "string")
      || !(candidate.updatedAt?.safetyAssessment != null && candidate.updatedAt.safetyAssessment > 0)) {
      throw new Error("Detail snapshot safety assessment lane is invalid or undated");
    }
  }
  for (const updatedAt of Object.values(candidate.updatedAt ?? {})) {
    if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < 0) {
      throw new Error("Detail snapshot source clock is invalid");
    }
  }
  return candidate as StablecoinDetailSnapshot;
}

function loadBuildAuthentication(): void {
  if (process.env.PHAROS_API_KEY?.trim() || process.env.SITE_API_SHARED_SECRET?.trim()) return;
  const envFile = resolve(REPO_ROOT, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

function hasGeneratorCredential(): boolean {
  return Object.keys(generatorFetchHeaders(`${API_ORIGIN}/api/stablecoins`))
    .some((name) => !["accept", "origin"].includes(name.toLowerCase()));
}

/**
 * Credentialed runs read the authoritative API; Pages
 * release builds carry no API secret and read the public GET-only
 * `/_site-data` lane the release refresh already uses.
 */
export function resolveSnapshotApiBase(): string {
  const configured = resolveGeneratorApiBase();
  if (configured) return configured;
  if (process.env.SITE_API_SHARED_SECRET?.trim()) return SITE_API_ORIGIN;
  if (hasGeneratorCredential()) return API_ORIGIN;
  return `${PAGES_APP_ORIGIN}${SITE_DATA_PATH_PREFIX}`;
}

function authenticatedGeneratorHeaders(url: string): Record<string, string> {
  const headers = generatorFetchHeaders(url);
  const isSiteDataRequest = new URL(url).pathname.startsWith(`${SITE_DATA_PATH_PREFIX}/`);
  const hasCredential = Object.keys(headers).some((name) => !["accept", "origin"].includes(name.toLowerCase()));
  if (!isSiteDataRequest && !hasCredential) {
    throw new Error("PHAROS_API_KEY or SITE_API_SHARED_SECRET is required for detail snapshot generation");
  }
  return headers;
}

async function fetchDetailSnapshotJson(url: string): Promise<{ data: unknown; updatedAt: number | null }> {
  const response = await fetchWithRetry(url, { headers: authenticatedGeneratorHeaders(url) }, {
    logLabel: "stablecoin-detail-snapshots",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new DetailSnapshotHttpError(url, response.status, body);
  }
  const data: unknown = await response.json();
  return { data, updatedAt: detailSnapshotSourceUpdatedAt(data, response.headers) };
}

export async function fetchOptionalDetailSnapshotLane<T>(
  label: string,
  url: string,
  schema: { parse(value: unknown): T },
): Promise<{ data: T; updatedAt?: number } | null> {
  try {
    const payload = await fetchDetailSnapshotJson(url);
    return { data: schema.parse(payload.data), ...(payload.updatedAt !== null ? { updatedAt: payload.updatedAt } : {}) };
  } catch (error) {
    if (error instanceof DetailSnapshotHttpError && (error.status === 404 || error.status === 410)) {
      console.warn(`[stablecoin-detail-snapshots] Omitting ${label} lane: ${error.message}`);
      return null;
    }
    throw error;
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await visit(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

export interface DetailSnapshotGenerationOptions {
  source?: "per-coin" | "bulk";
  generatedAt?: number;
  staleRefreshLimit?: number;
}

interface SnapshotCoinLanes {
  id: string;
  liveSummary: StablecoinLiveSummary | null;
  supplyHistory: SupplyHistoryPoint[] | null;
  updatedAt: StablecoinDetailSnapshot["updatedAt"];
}

export async function generateSnapshots(
  bootstrap = process.env.PHAROS_DETAIL_SNAPSHOT_BOOTSTRAP === "1",
  options: DetailSnapshotGenerationOptions = {},
): Promise<StablecoinDetailSnapshot[]> {
  if (bootstrap) {
    // Bootstrap needs valid importable envelopes, not live data or credentials.
    return buildStablecoinDetailSnapshots({
      generatedAt: 0,
      liveSummariesById: new Map(),
      supplyHistoryById: new Map(),
      updatedAtById: new Map(),
    });
  }
  loadBuildAuthentication();
  const apiBase = resolveSnapshotApiBase();
  const liveIds = TRACKED_STABLECOINS
    .filter((coin) => coin.status == null || coin.status === "active" || coin.status === "frozen")
    .map((coin) => coin.id);
  let source = options.source ?? process.env.PHAROS_DETAIL_SNAPSHOT_SOURCE ?? "per-coin";
  if (source !== "per-coin" && source !== "bulk") {
    throw new Error(`Invalid PHAROS_DETAIL_SNAPSHOT_SOURCE: ${source}`);
  }
  if (source === "bulk" && !process.env.SITE_API_SHARED_SECRET?.trim()) {
    // Credentialless Pages releases retain the ordinary public per-coin transport.
    console.warn("[stablecoin-detail-snapshots] bulk requires SITE_API_SHARED_SECRET; using per-coin acquisition");
    source = "per-coin";
  }
  const fetchCoin = async (id: string): Promise<SnapshotCoinLanes> => {
    const detail = await fetchOptionalDetailSnapshotLane(
      `coin detail for ${id}`,
      resolveApiPathUrl(apiBase, API_PATHS.stablecoinDetail(id)),
      StablecoinDetailResponseSchema,
    );
    const history = await fetchOptionalDetailSnapshotLane(
      `supply history for ${id}`,
      resolveApiPathUrl(apiBase, API_PATHS.supplyHistory(id, STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS)),
      SupplyHistoryResponseSchema,
    );
    if (!detail && !history) {
      throw new Error(`No detail snapshot lanes were available for live stablecoin ${id}.`);
    }
    return {
      id,
      liveSummary: detail ? projectStablecoinLiveSummary(detail.data) : null,
      supplyHistory: history?.data ?? null,
      updatedAt: {
        ...(detail?.updatedAt != null ? { liveSummary: detail.updatedAt } : {}),
        ...(history?.updatedAt != null ? { supplyHistory: history.updatedAt } : {}),
      },
    };
  };
  const lanes: SnapshotCoinLanes[] = [];
  const assessedAt = options.generatedAt ?? Date.now();
  const acquisition: Array<{
    id: string;
    source: "per-coin" | "bulk-cache-only" | "bulk-unavailable-fallback" | "bulk-stale-refresh";
    updatedAt: SnapshotCoinLanes["updatedAt"];
    bulkUpdatedAt?: SnapshotCoinLanes["updatedAt"];
    bulkSources?: DetailSnapshotInputEntry["sources"];
    reason?: string;
  }> = [];
  let staleCandidateCount = 0;
  if (source === "per-coin") {
    lanes.push(...await mapWithConcurrency(liveIds, MAX_PARALLEL_COIN_REQUESTS, fetchCoin));
    acquisition.push(...lanes.map((lane) => ({ id: lane.id, source: "per-coin" as const, updatedAt: lane.updatedAt })));
  } else {
    // Bulk is an internal site-only transport even when ordinary per-coin reads
    // use the public API key lane. Explicit site/preview bases remain supported.
    const bulkApiBase = apiBase === API_ORIGIN || new URL(apiBase).pathname.startsWith(SITE_DATA_PATH_PREFIX)
      ? SITE_API_ORIGIN
      : apiBase;
    const batches: string[][] = [];
    for (let offset = 0; offset < liveIds.length; offset += DETAIL_SNAPSHOT_INPUT_BATCH_SIZE) {
      batches.push(liveIds.slice(offset, offset + DETAIL_SNAPSHOT_INPUT_BATCH_SIZE));
    }
    const responses = await mapWithConcurrency(batches, MAX_PARALLEL_BULK_REQUESTS, async (ids) => {
      const payload = await fetchDetailSnapshotJson(
        resolveApiPathUrl(bulkApiBase, API_PATHS.stablecoinDetailSnapshotInputs(ids)),
      );
      const { entries } = DetailSnapshotInputsResponseSchema.parse(payload.data);
      const requested = new Set(ids);
      const received = new Set(entries.map((entry) => entry.id));
      if (entries.length !== ids.length || received.size !== ids.length || entries.some((entry) => !requested.has(entry.id))) {
        throw new Error("Bulk detail snapshot response did not account for every requested coin exactly once");
      }
      return entries;
    });
    const entries = responses.flat();
    staleCandidateCount = entries.filter((entry) =>
      entry.status === "available" && assessedAt - entry.updatedAt.liveSummary > DETAIL_SNAPSHOT_UI_STALE_AFTER_MS).length;
    const refreshIds = new Set(selectStaleDetailSnapshotRefreshIds(entries, assessedAt, options.staleRefreshLimit));
    // Separate phases keep stale refreshes and unavailable fallbacks within the
    // same global cap. Each coin consumes detail then history sequentially.
    const acquired = await mapWithConcurrency(entries, MAX_PARALLEL_COIN_REQUESTS, async (entry) => {
      const refresh = refreshIds.has(entry.id);
      const source: (typeof acquisition)[number]["source"] = entry.status === "unavailable" ? "bulk-unavailable-fallback"
        : refresh ? "bulk-stale-refresh" : "bulk-cache-only";
      let lane: SnapshotCoinLanes;
      if (entry.status === "unavailable" || refresh) {
        console.warn(`[stablecoin-detail-snapshots] ${source} for ${entry.id}; fetching per-coin`);
        // The route may serve the original generation while revalidating. Do not
        // mistake a successful GET for a new producer generation or re-stamp it.
        lane = await fetchCoin(entry.id);
      } else {
        lane = {
          id: entry.id,
          liveSummary: normalizeStablecoinLiveSummary(entry.liveSummary),
          supplyHistory: entry.supplyHistory,
          updatedAt: entry.updatedAt,
        };
      }
      return { lane, provenance: {
        id: entry.id, source, updatedAt: lane.updatedAt, bulkSources: entry.sources,
        ...(entry.status === "available" ? { bulkUpdatedAt: entry.updatedAt } : { reason: entry.reason }),
      } };
    });
    lanes.push(...acquired.map(({ lane }) => lane));
    acquisition.push(...acquired.map(({ provenance }) => provenance));
  }
  // Keep run-scoped provenance in build evidence, not the byte-equivalent seed
  // envelope. "stale-refresh" names the path read, not a claim of newer data.
  console.log(JSON.stringify({ detailSnapshotAcquisition: {
    assessedAt, staleRefreshBudgetMs: DETAIL_SNAPSHOT_UI_STALE_AFTER_MS,
    staleRefreshLimit: options.staleRefreshLimit ?? DETAIL_SNAPSHOT_STALE_REFRESH_LIMIT,
    staleCandidateCount, entries: acquisition,
  } }));
  return buildStablecoinDetailSnapshots({
    generatedAt: options.generatedAt ?? Date.now(),
    liveSummariesById: new Map(lanes.map((lane) => [lane.id, lane.liveSummary])),
    supplyHistoryById: new Map(lanes.map((lane) => [lane.id, lane.supplyHistory])),
    updatedAtById: new Map(lanes.map((lane) => [lane.id, lane.updatedAt])),
  });
}

function reportSizes(snapshots: readonly StablecoinDetailSnapshot[]): Record<string, number> {
  return Object.fromEntries(snapshots.map((snapshot) => [
    snapshot.stablecoinId,
    serializedSnapshotBytes(snapshot),
  ]));
}

export function writeSnapshots(snapshots: readonly StablecoinDetailSnapshot[], outputDir = DETAIL_SNAPSHOT_OUTPUT_DIR): void {
  mkdirSync(outputDir, { recursive: true });
  const expectedFiles = new Set(snapshots.map((snapshot) => `${snapshot.stablecoinId}.json`));
  for (const file of readdirSync(outputDir)) {
    if (file.endsWith(".json") && !expectedFiles.has(file)) unlinkSync(resolve(outputDir, file));
  }
  for (const snapshot of snapshots) {
    validateStablecoinDetailSnapshot(snapshot);
    writeFileSync(resolve(outputDir, `${snapshot.stablecoinId}.json`), `${JSON.stringify(snapshot)}\n`);
  }
}

export function checkSnapshots(outputDir = DETAIL_SNAPSHOT_OUTPUT_DIR): StablecoinDetailSnapshot[] {
  if (!existsSync(outputDir)) throw new Error("Stablecoin detail snapshots are not generated");
  const expectedFiles = new Set(TRACKED_STABLECOINS.map((coin) => `${coin.id}.json`));
  const obsolete = readdirSync(outputDir).filter((file) => file.endsWith(".json") && !expectedFiles.has(file));
  if (obsolete.length > 0) throw new Error(`Obsolete stablecoin detail snapshots: ${obsolete.join(", ")}`);
  return TRACKED_STABLECOINS.map((coin) => {
    const path = resolve(outputDir, `${coin.id}.json`);
    if (!existsSync(path)) throw new Error(`Missing stablecoin detail snapshot: ${coin.id}`);
    const snapshot = validateStablecoinDetailSnapshot(JSON.parse(readFileSync(path, "utf8")));
    if (snapshot.stablecoinId !== coin.id) throw new Error(`Snapshot ID mismatch for ${coin.id}`);
    return snapshot;
  });
}

export async function runCli(check = process.env.PHAROS_DETAIL_SNAPSHOT_CHECK === "1"): Promise<void> {
  const snapshots = check ? checkSnapshots() : await generateSnapshots();
  if (!check) writeSnapshots(snapshots);
  const sizes = reportSizes(snapshots);
  const oversized = Object.entries(sizes).filter(([, bytes]) => bytes > DETAIL_SNAPSHOT_TARGET_BYTES);
  const laneCounts = {
    liveSummary: snapshots.filter((snapshot) => snapshot.lanes.liveSummary != null).length,
    supplyHistory: snapshots.filter((snapshot) => snapshot.lanes.supplyHistory != null).length,
    safetyAssessment: snapshots.filter((snapshot) => snapshot.lanes.safetyAssessment != null).length,
    empty: snapshots.filter((snapshot) => Object.keys(snapshot.lanes).length === 0).length,
  };
  console.log(JSON.stringify({
    snapshotBytesByCoin: sizes,
    laneCounts,
    maxSnapshotBytes: Math.max(...Object.values(sizes)),
  }));
  if (oversized.length > 0) {
    console.warn(`[stablecoin-detail-snapshots] ${oversized.length} snapshots exceed the 8 KiB target`);
  }
  console.log(`[stablecoin-detail-snapshots] ${check ? "validated" : "wrote"} ${snapshots.length} snapshots`);
}

// Importing this module from the equivalence tool must never write repo outputs.
runDirectCli(import.meta.url, runCli, { label: "stablecoin-detail-snapshots" });
