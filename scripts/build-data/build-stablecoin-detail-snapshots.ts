#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { API_ORIGIN, PAGES_APP_ORIGIN, SITE_API_ORIGIN } from "@shared/lib/runtime-origins";
import { SITE_DATA_PATH_PREFIX } from "@shared/lib/site-data-lane";
import { isRecord } from "@shared/lib/type-guards";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  StablecoinDetailResponseSchema,
  SupplyHistoryResponseSchema,
  type SupplyHistoryPoint,
} from "@shared/types/market";
import type { StablecoinDetailSnapshot } from "../../src/lib/api";
import {
  STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS,
  StablecoinLiveSummarySchema,
  projectStablecoinLiveSummary,
  type StablecoinLiveSummary,
} from "../../src/lib/api-query-descriptors";
import {
  fetchWithRetry,
  generatorFetchHeaders,
  resolveApiPathUrl,
  resolveGeneratorApiBase,
} from "../lib/sync-from-api";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DETAIL_SNAPSHOT_OUTPUT_DIR = resolve(REPO_ROOT, "src/generated/stablecoin-detail-snapshots");
export const DETAIL_SNAPSHOT_TARGET_BYTES = 8 * 1024;
const MAX_PARALLEL_COIN_REQUESTS = 6;

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
}

export function buildStablecoinDetailSnapshots(inputs: SnapshotInputs): StablecoinDetailSnapshot[] {
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

async function fetchDetailSnapshotJson(url: string): Promise<{ data: unknown; updatedAt: number }> {
  const response = await fetchWithRetry(url, { headers: authenticatedGeneratorHeaders(url) }, {
    logLabel: "stablecoin-detail-snapshots",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new DetailSnapshotHttpError(url, response.status, body);
  }
  const data: unknown = await response.json();
  const meta = isRecord(data) && isRecord(data._meta) ? data._meta : null;
  const sourceUpdatedAt = meta?.updatedAt ?? (isRecord(data) ? data.updatedAt : undefined);
  if (typeof sourceUpdatedAt === "number" && Number.isFinite(sourceUpdatedAt) && sourceUpdatedAt >= 0) {
    return { data, updatedAt: sourceUpdatedAt * 1000 };
  }
  const date = Date.parse(response.headers.get("Date") ?? "");
  const age = Number(response.headers.get("X-Data-Age") ?? 0);
  const edgeAge = Number(response.headers.get("Age") ?? 0);
  // A server Date already predates edge residence. Without it, subtract both ages.
  const acquiredAt = Number.isFinite(date) ? date : Date.now() - (Number.isFinite(edgeAge) ? edgeAge * 1000 : 0);
  return { data, updatedAt: Math.max(0, acquiredAt - (Number.isFinite(age) ? age * 1000 : 0)) };
}

export async function fetchOptionalDetailSnapshotLane<T>(
  label: string,
  url: string,
  schema: { parse(value: unknown): T },
): Promise<{ data: T; updatedAt: number } | null> {
  try {
    const payload = await fetchDetailSnapshotJson(url);
    return { data: schema.parse(payload.data), updatedAt: payload.updatedAt };
  } catch (error) {
    if (error instanceof DetailSnapshotHttpError) {
      console.warn(`[stablecoin-detail-snapshots] Omitting ${label} lane: ${error.message}`);
      return null;
    }
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      const issuePath = issue?.path.length ? issue.path.map(String).join(".") : "<root>";
      const issueMessage = issue?.message ?? "unknown schema validation error";
      const warning = `[stablecoin-detail-snapshots] Omitting ${label} lane: ` +
        `schema validation failed at ${issuePath}: ${issueMessage}`;
      console.warn(warning.slice(0, 360));
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

export async function generateSnapshots(
  bootstrap = process.env.PHAROS_DETAIL_SNAPSHOT_BOOTSTRAP === "1",
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
  const lanes = await mapWithConcurrency(liveIds, MAX_PARALLEL_COIN_REQUESTS, async (id) => {
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
    return [id, detail, history] as const;
  });
  return buildStablecoinDetailSnapshots({
    generatedAt: Date.now(),
    liveSummariesById: new Map(lanes.map(([id, detail]) => [
      id,
      detail ? projectStablecoinLiveSummary(detail.data) : null,
    ])),
    supplyHistoryById: new Map(lanes.map(([id, , history]) => [id, history?.data ?? null])),
    updatedAtById: new Map(lanes.map(([id, detail, history]) => [id, {
      ...(detail ? { liveSummary: detail.updatedAt } : {}),
      ...(history ? { supplyHistory: history.updatedAt } : {}),
    }])),
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

// This file is both the registered entrypoint and the unit-test import surface.
// Vitest sets VITEST for module imports; every registered command runs the CLI.
if (!process.env.VITEST) {
  runCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
