/**
 * Generate public dataset snapshots + stable latest/Sheets aliases (ideas 11.7 + 11.8 fused).
 *
 * Reads from W2-A's daily snapshot API (`GET /api/snapshots/<YYYY-MM-DD>.json`)
 * plus the committed depeg event yearly shards for the depeg-history topic. Emits:
 *
 *   public/datasets/<topic>/<YYYY-MM-DD>.{csv,json,ndjson}     (90-day retention)
 *
 * A generated block in `public/_redirects` serves both `/datasets/<topic>/latest.*`
 * and IMPORTDATA-friendly `/sheets/<topic>.csv` URLs as 200 rewrites to the dated
 * files. No byte-identical alias files are written.
 *
 * Topics: top-stablecoins, depeg-history, scores-latest, peg-mechanism-distribution.
 *
 * `--check` mode: verify that every latest/Sheets rewrite resolves directly to
 * an existing dated file, that artifacts carry recognizable preambles, and that
 * each topic satisfies its row floor. Does NOT re-fetch (network-flakey in CI).
 * `--check --integrity-only` waives only maximum mirror age for PR validation.
 *
 * CLI option: `--repoint-current` allows a historical run to replace latest aliases/current frontend imports.
 *
 * Configure via env:
 *   PUBLIC_DATASETS_API_URL   — base API URL, e.g. `https://api.pharos.watch`
 *   SMOKE_API_BASE / API_BASE_URL — fallback bases (mirrors sync-digests)
 *   PUBLIC_DATASETS_API_KEY   — optional `X-API-Key` header
 *   PUBLIC_DATASETS_DATE      — optional ISO date to fetch (default: today UTC); historical dates require the matching snapshot
 *   PUBLIC_DATASETS_REQUIRE_API=1 — fail if no API base is configured
 *   PUBLIC_DATASETS_ALLOW_EXISTING_ON_FETCH_FAILURE=1 — preserve valid mirrors if live fetch fails
 *
 * When no API base is configured, valid checked-in mirrors are preserved for
 * local/PR validation builds. Production Pages workflows set
 * `PUBLIC_DATASETS_REQUIRE_API=1` so they fail closed instead of shipping stale
 * mirrors. Use `--allow-stub` or `PUBLIC_DATASETS_ALLOW_STUB=1` only for
 * explicit local placeholder regeneration.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PUBLIC_DATASET_TOPICS, type PublicDatasetTopic } from "@shared/lib/api-endpoints/datasets";
import { formatUtcDateOnly } from "@shared/lib/format";
import type { DepegEvent } from "@shared/types/peg";
import { PublicSnapshotEnvelopeSchema } from "@shared/types/public-snapshot";
import { DEPEG_EVENT_DATA_DIR, readDepegEventSnapshot } from "../../src/lib/depeg-event-snapshot";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { projectRetiredPublicRouteRedirects } from "../lib/retired-public-routes.mjs";
import { readDepegLedgerCapture, type DepegLedgerCapture } from "../lib/depeg-ledger-capture";
import {
  RETENTION_DAYS,
  buildTopicSpecs,
  buildTopicArtifacts,
  isHistoricalSnapshotDate,
  isProjectionEnvelope,
  validateDepegHistoryCoverage,
  validateScoresLatestDisplayProjection,
  type SnapshotEnvelope,
  type TopicSpec,
} from "../lib/public-dataset-projections";
import {
  RELEASE_DATA_FALLBACK_ENV_NAME,
  generatorFetchHeaders,
  resolveApiPathUrl,
  resolveGeneratorApiBase,
  shouldAllowExistingDataOnFetchFailure,
} from "../lib/sync-from-api";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const DATASETS_DIR = join(REPO_ROOT, "public/datasets");
const REDIRECTS_PATH = join(REPO_ROOT, "public/_redirects");
const CURRENT_DATASET_MODULE_PATH = join(REPO_ROOT, "src/lib/datasets/public-dataset-current.ts");
const REDIRECT_BLOCK_START = "# BEGIN GENERATED PUBLIC DATASET ALIASES";
const REDIRECT_BLOCK_END = "# END GENERATED PUBLIC DATASET ALIASES";
const REQUIRE_API_SOURCE = process.env.PUBLIC_DATASETS_REQUIRE_API === "1";
const MAX_CURRENT_DATASET_AGE_DAYS = 2;
const ROW_FLOORS: Readonly<Record<PublicDatasetTopic, number>> = {
  "top-stablecoins": 493,
  // A quiet market legitimately shrinks this rolling 90-day window (300 -> 60 -> 0 as stricter
  // confirmation cut monthly events below ten). Truncation is caught instead by the full-ledger
  // capture count, window coverage, and source-shard checks.
  "depeg-history": 0,
  "scores-latest": 493,
  "peg-mechanism-distribution": 99,
};

function resolveSnapshotDate(): string {
  return process.env.PUBLIC_DATASETS_DATE?.trim() || formatUtcDateOnly(new Date());
}

async function safeFetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: generatorFetchHeaders(url) });
    if (!res.ok) {
      console.warn(`[generate-public-datasets] ${url} → HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[generate-public-datasets] ${url} fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function fetchSnapshot(apiBase: string, date: string): Promise<SnapshotEnvelope | null> {
  const url = resolveApiPathUrl(apiBase, `/api/snapshots/${date}.json`);
  const payload = await safeFetchJson<unknown>(url);
  if (payload == null) return null;

  const parsed = PublicSnapshotEnvelopeSchema.safeParse(payload);
  if (!parsed.success || !isProjectionEnvelope(parsed.data)) {
    console.warn(`[generate-public-datasets] ${url} returned an invalid public snapshot envelope`);
    return null;
  }
  return parsed.data;
}

function readDepegEventsFromShards(): DepegEvent[] {
  return readDepegEventSnapshot({ missing: "throw" });
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeArtifact(path: string, contents: string): { changed: boolean } {
  const previous = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (previous === contents) {
    return { changed: false };
  }
  ensureDir(dirname(path));
  writeFileSync(path, contents, "utf8");
  return { changed: true };
}

function buildPublicDatasetRedirectBlock(snapshotDate: string): string {
  const lines = [
    REDIRECT_BLOCK_START,
    "# Generated by scripts/maintenance/generate-public-datasets.ts. Do not edit by hand.",
    "# Cloudflare Pages 200 rewrites preserve direct-fetch URLs without redirect chains.",
  ];
  for (const topic of PUBLIC_DATASET_TOPICS) {
    for (const variant of ["csv", "json", "ndjson"] as const) {
      lines.push(`/datasets/${topic}/latest.${variant} /datasets/${topic}/${snapshotDate}.${variant} 200`);
    }
  }
  lines.push("# Sheets aliases rewrite directly to dated CSVs; Pages does not follow chained redirects.");
  for (const topic of PUBLIC_DATASET_TOPICS) {
    lines.push(`/sheets/${topic}.csv /datasets/${topic}/${snapshotDate}.csv 200`);
  }
  lines.push(REDIRECT_BLOCK_END);
  return `${lines.join("\n")}\n`;
}

function writePublicDatasetRedirects(snapshotDate: string, redirectsPath = REDIRECTS_PATH): { changed: boolean } {
  const redirects = readFileSync(redirectsPath, "utf8");
  const start = redirects.indexOf(REDIRECT_BLOCK_START);
  const end = redirects.indexOf(REDIRECT_BLOCK_END);
  if (start < 0 || end < start) {
    throw new Error(`Public dataset redirect markers missing or out of order in ${redirectsPath}`);
  }
  const after = end + REDIRECT_BLOCK_END.length;
  const replacement = buildPublicDatasetRedirectBlock(snapshotDate).trimEnd();
  return writeArtifact(redirectsPath, projectRetiredPublicRouteRedirects(
    `${redirects.slice(0, start)}${replacement}${redirects.slice(after)}`,
  ));
}

function buildPublicDatasetCurrentModule(snapshotDate: string): string {
  const imports = PUBLIC_DATASET_TOPICS.map((topic) => {
    const name = `${topic.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())}Export`;
    return {
      name,
      topic,
      statement: `import ${name} from "../../../public/datasets/${topic}/${snapshotDate}.json";`,
    };
  });
  return [
    "/** Generated by scripts/maintenance/generate-public-datasets.ts. Do not edit by hand. */",
    ...imports.map(({ statement }) => statement),
    "",
    `export const PUBLIC_DATASET_CURRENT_DATE = "${snapshotDate}";`,
    `export const PUBLIC_DATASET_MAX_AGE_DAYS = ${MAX_CURRENT_DATASET_AGE_DAYS};`,
    "",
    "export const PUBLIC_DATASET_CURRENT_EXPORTS = {",
    ...imports.map(({ name, topic }) => `  "${topic}": ${name},`),
    "} as const;",
    "",
  ].join("\n");
}

function writePublicDatasetCurrentModule(
  snapshotDate: string,
  modulePath = CURRENT_DATASET_MODULE_PATH,
): { changed: boolean } {
  return writeArtifact(modulePath, buildPublicDatasetCurrentModule(snapshotDate));
}

function pruneOldSnapshots(topicDir: string, snapshotDate: string): number {
  if (!existsSync(topicDir)) return 0;
  const cutoffMs = new Date(`${snapshotDate}T00:00:00Z`).getTime() - RETENTION_DAYS * 86_400_000;
  const cutoffDate = formatUtcDateOnly(new Date(cutoffMs));
  let removed = 0;
  for (const name of readdirSync(topicDir)) {
    const match = /^(\d{4}-\d{2}-\d{2})\.(csv|json|ndjson)$/.exec(name);
    if (!match) continue;
    if (match[1] < cutoffDate) {
      rmSync(join(topicDir, name));
      removed += 1;
    }
  }
  return removed;
}

function writeTopic<T>(
  spec: TopicSpec<T>,
  snapshotDate: string,
  asOfISO: string,
): { dated: string[]; written: number } {
  const topicDir = join(DATASETS_DIR, spec.topic);
  const artifacts = buildTopicArtifacts(spec, asOfISO);

  const targets = [
    { path: join(topicDir, `${snapshotDate}.csv`), contents: artifacts.csv },
    { path: join(topicDir, `${snapshotDate}.json`), contents: artifacts.json },
    { path: join(topicDir, `${snapshotDate}.ndjson`), contents: artifacts.ndjson },
  ];

  let written = 0;
  for (const target of targets) {
    const result = writeArtifact(target.path, target.contents);
    if (result.changed) written += 1;
  }

  return { dated: [`${snapshotDate}.csv`, `${snapshotDate}.json`, `${snapshotDate}.ndjson`], written };
}

interface ArtifactDirs {
  datasetsDir: string;
  redirectsPath: string;
  currentDatasetModulePath: string;
}

const DEFAULT_ARTIFACT_DIRS: ArtifactDirs = {
  datasetsDir: DATASETS_DIR,
  redirectsPath: REDIRECTS_PATH,
  currentDatasetModulePath: CURRENT_DATASET_MODULE_PATH,
};

function readRedirectRules(path: string): Map<string, { destination: string; status: string }> {
  const rules = new Map<string, { destination: string; status: string }>();
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [source, destination, status = "302"] = line.split(/\s+/);
    if (source && destination) rules.set(source, { destination, status });
  }
  return rules;
}

interface JsonArtifactMetadata {
  rowCount: number;
  actualRowCount: number;
  displayProjection: unknown;
}

function readJsonArtifactMetadata(path: string, topic: PublicDatasetTopic): JsonArtifactMetadata | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      _meta?: { endpoint?: string; rowCount?: unknown; displayProjection?: unknown };
      rows?: unknown;
    };
    if (parsed._meta?.endpoint !== topic || typeof parsed._meta.rowCount !== "number") return null;
    return {
      rowCount: parsed._meta.rowCount,
      actualRowCount: Array.isArray(parsed.rows) ? parsed.rows.length : -1,
      displayProjection: parsed._meta.displayProjection,
    };
  } catch {
    return null;
  }
}

function validateTopicRowFloor(topic: PublicDatasetTopic, rows: readonly unknown[]): void {
  const floor = ROW_FLOORS[topic];
  if (rows.length < floor) {
    throw new Error(`Public dataset ${topic} has ${rows.length} rows; expected at least ${floor}.`);
  }
}

function checkTopic(
  topic: PublicDatasetTopic,
  dirs: ArtifactDirs = DEFAULT_ARTIFACT_DIRS,
): { ok: boolean; reason?: string } {
  const rules = readRedirectRules(dirs.redirectsPath);
  const resolved = new Map<"csv" | "json" | "ndjson", string>();
  for (const variant of ["csv", "json", "ndjson"] as const) {
    const source = `/datasets/${topic}/latest.${variant}`;
    const rule = rules.get(source);
    // eslint-disable-next-line security/detect-non-literal-regexp -- topic/variant are compile-time dataset literals
    const expectedDestination = new RegExp(`^/datasets/${topic}/\\d{4}-\\d{2}-\\d{2}\\.${variant}$`);
    if (!rule || rule.status !== "200" || !expectedDestination.test(rule.destination)) {
      return { ok: false, reason: `${source} must be a 200 rewrite to a dated ${variant} artifact` };
    }
    resolved.set(variant, join(dirs.datasetsDir, topic, rule.destination.split("/").at(-1)!));
  }
  const sheetSource = `/sheets/${topic}.csv`;
  const sheetRule = rules.get(sheetSource);
  const csvDestination = rules.get(`/datasets/${topic}/latest.csv`)?.destination;
  if (!sheetRule || sheetRule.status !== "200" || sheetRule.destination !== csvDestination) {
    return { ok: false, reason: `${sheetSource} must rewrite directly to the dated CSV artifact` };
  }

  for (const [variant, path] of resolved) {
    if (!existsSync(path)) {
      return { ok: false, reason: `${path} missing` };
    }
    const head = readFileSync(path, "utf8").slice(0, 512);
    const hasPreamble = variant === "csv"
      ? head.startsWith("# Pharos pharos.watch")
      : variant === "json"
        ? head.includes(`"_meta"`) && head.includes(`"endpoint": "${topic}"`)
        : head.startsWith(`{"_meta":`) && head.includes(`"endpoint":"${topic}"`);
    if (!hasPreamble) {
      return { ok: false, reason: `${path} missing preamble` };
    }
  }
  const jsonPath = resolved.get("json")!;
  const jsonMetadata = readJsonArtifactMetadata(jsonPath, topic);
  const floor = ROW_FLOORS[topic];
  if (jsonMetadata == null) {
    return { ok: false, reason: `${jsonPath} missing numeric _meta.rowCount` };
  }
  if (jsonMetadata.actualRowCount !== jsonMetadata.rowCount) {
    return {
      ok: false,
      reason: `${topic} rowCount ${jsonMetadata.rowCount} does not match rows length ${jsonMetadata.actualRowCount}`,
    };
  }
  if (jsonMetadata.rowCount < floor) {
    return { ok: false, reason: `${topic} rowCount ${jsonMetadata.rowCount} below required floor ${floor}` };
  }
  if (topic === "scores-latest") {
    const artifactDate = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(basename(jsonPath))?.[1] ?? "";
    const projection = validateScoresLatestDisplayProjection(jsonMetadata.displayProjection, artifactDate);
    if (!projection.ok) return projection;
  }
  return { ok: true };
}

function checkCurrentDatasetModule(
  dirs: ArtifactDirs = DEFAULT_ARTIFACT_DIRS,
  integrityOnly = false,
): { ok: boolean; reason?: string } {
  const rule = readRedirectRules(dirs.redirectsPath).get("/datasets/top-stablecoins/latest.json");
  const snapshotDate = /^\/datasets\/top-stablecoins\/(\d{4}-\d{2}-\d{2})\.json$/.exec(rule?.destination ?? "")?.[1];
  if (!snapshotDate) {
    return { ok: false, reason: "top-stablecoins latest.json is not a dated rewrite" };
  }
  const today = formatUtcDateOnly(new Date());
  const snapshotMs = Date.parse(`${snapshotDate}T00:00:00Z`);
  const ageDays =
    (Date.parse(`${today}T00:00:00Z`) - snapshotMs) / 86_400_000;
  if (!Number.isInteger(ageDays) || new Date(snapshotMs).toISOString().slice(0, 10) !== snapshotDate
    || ageDays < 0 || (!integrityOnly && ageDays > MAX_CURRENT_DATASET_AGE_DAYS)) {
    return {
      ok: false,
      reason:
        `latest.json points to ${snapshotDate}; expected a valid non-future snapshot date`
        + (integrityOnly ? "" : ` no more than ${MAX_CURRENT_DATASET_AGE_DAYS} days old`),
    };
  }
  const expected = buildPublicDatasetCurrentModule(snapshotDate);
  if (!existsSync(dirs.currentDatasetModulePath)) {
    return { ok: false, reason: `${dirs.currentDatasetModulePath} missing` };
  }
  if (readFileSync(dirs.currentDatasetModulePath, "utf8") !== expected) {
    return { ok: false, reason: `${dirs.currentDatasetModulePath} does not match current dataset redirects` };
  }
  return { ok: true };
}

interface PublicDatasetLiveInputs {
  envelope: SnapshotEnvelope;
  depegEvents: DepegEvent[];
  effectiveSnapshotDate: string;
  asOfISO: string;
  depegCapture: DepegLedgerCapture;
}

function validateDepegHistorySourceShard(snapshotDate: string): void {
  const snapshotYear = snapshotDate.slice(0, 4);
  if (!/^\d{4}$/.test(snapshotYear) || !existsSync(join(DEPEG_EVENT_DATA_DIR, `${snapshotYear}.json`))) {
    throw new Error(
      `Depeg event source has no ${snapshotYear || "requested-year"} shard for snapshot ${snapshotDate}; `
      + "refusing a potentially stale public dataset.",
    );
  }
}

function asOfIsoFromEnvelope(envelope: SnapshotEnvelope, snapshotDate: string): string {
  return envelope.generatedAt > 0
    ? new Date(envelope.generatedAt * 1000).toISOString()
    : `${snapshotDate}T00:00:00.000Z`;
}

async function fetchLatestSnapshotDate(apiBase: string): Promise<string | null> {
  const indexPayload = await safeFetchJson<{ snapshots: Array<{ snapshotDate: string }> }>(
    resolveApiPathUrl(apiBase, "/api/snapshots/index"),
  );
  return indexPayload?.snapshots[0]?.snapshotDate ?? null;
}

export async function loadPublicDatasetLiveInputs(
  apiBase: string,
  requestedSnapshotDate: string,
): Promise<PublicDatasetLiveInputs> {
  const historical = isHistoricalSnapshotDate(requestedSnapshotDate);
  let effectiveSnapshotDate = requestedSnapshotDate;
  let envelope = await fetchSnapshot(apiBase, requestedSnapshotDate);
  if (!envelope) {
    if (historical) {
      throw new Error(
        `No immutable public snapshot is available for historical date ${requestedSnapshotDate}; `
          + "API-backed public dataset generation requires the exact dated snapshot.",
      );
    }
    const latestDate = await fetchLatestSnapshotDate(apiBase);
    if (latestDate) {
      effectiveSnapshotDate = latestDate;
      envelope = await fetchSnapshot(apiBase, latestDate);
    }
    if (!envelope) {
      const latestDetail = latestDate
        ? `latest indexed snapshot ${latestDate} could not be fetched`
        : "the snapshot index contains no latest sealed snapshot";
      throw new Error(
        `No immutable public snapshot is available for current-date build ${requestedSnapshotDate}; ${latestDetail}. `
          + "API-backed public dataset generation requires today's snapshot or the latest sealed snapshot.",
      );
    }
  }
  effectiveSnapshotDate = envelope.snapshotDate || effectiveSnapshotDate;
  const asOfISO = asOfIsoFromEnvelope(envelope, effectiveSnapshotDate);

  const depegEvents = readDepegEventsFromShards();
  validateDepegHistorySourceShard(effectiveSnapshotDate);
  validateDepegHistoryCoverage(depegEvents, effectiveSnapshotDate);
  const depegCapture = readDepegLedgerCapture(DEPEG_EVENT_DATA_DIR);
  if (depegCapture.eventCount !== depegEvents.length) {
    throw new Error("Depeg ledger capture event count does not match the source shards");
  }
  return { envelope, depegEvents, depegCapture, effectiveSnapshotDate, asOfISO };
}

export const testExports = {
  buildPublicDatasetCurrentModule,
  buildPublicDatasetRedirectBlock,
  checkTopic,
  checkAllTopics,
  checkCurrentDatasetModule,
  validateDepegHistorySourceShard,
  validateTopicRowFloor,
};

function checkAllTopics(
  dirs: ArtifactDirs = DEFAULT_ARTIFACT_DIRS,
  integrityOnly = false,
): { ok: boolean; reason?: string } {
  for (const topic of PUBLIC_DATASET_TOPICS) {
    const result = checkTopic(topic, dirs);
    if (!result.ok) return result;
  }
  const current = checkCurrentDatasetModule(dirs, integrityOnly);
  if (!current.ok) return current;
  const redirects = readFileSync(dirs.redirectsPath, "utf8");
  if (projectRetiredPublicRouteRedirects(redirects) !== redirects) {
    return { ok: false, reason: "retired public route redirects differ from their declared policy" };
  }
  return current;
}

function shouldPreserveExistingDatasetMirrorsAfterFetchFailure(): boolean {
  return shouldAllowExistingDataOnFetchFailure(["PUBLIC_DATASETS_ALLOW_EXISTING_ON_FETCH_FAILURE"]);
}

function preserveExistingDatasetMirrorsAfterFetchFailure(error: unknown): boolean {
  if (!shouldPreserveExistingDatasetMirrorsAfterFetchFailure()) {
    return false;
  }
  const existing = checkAllTopics();
  if (!existing.ok) {
    console.error(
      `[generate-public-datasets] Live API fetch failed and checked-in mirrors are not current: ${existing.reason}`,
    );
    return false;
  }
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(
    `[generate-public-datasets] Live API fetch failed (${reason}); preserving checked-in public dataset mirrors. ` +
      `Unset ${RELEASE_DATA_FALLBACK_ENV_NAME} / PUBLIC_DATASETS_ALLOW_EXISTING_ON_FETCH_FAILURE to fail closed.`,
  );
  return true;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean", default: false },
      "allow-stub": { type: "boolean", default: false },
      "repoint-current": { type: "boolean", default: false },
      "integrity-only": { type: "boolean", default: false },
    },
  });
  if (values["integrity-only"] && !values.check) {
    throw new Error("--integrity-only requires --check");
  }
  const allowStub = values["allow-stub"] || process.env.PUBLIC_DATASETS_ALLOW_STUB === "1";
  const requestedSnapshotDate = resolveSnapshotDate();
  let snapshotDate = requestedSnapshotDate;

  if (values.check) {
    const result = checkAllTopics(DEFAULT_ARTIFACT_DIRS, values["integrity-only"]);
    if (!result.ok) {
      console.error(
        `Public dataset mirrors failed validation. Run \`tsx scripts/maintenance/generate-public-datasets.ts\`. (${result.reason})`,
      );
      process.exit(1);
    }
    console.log(values["integrity-only"] ? "Public dataset mirror integrity passed" : "Public dataset mirrors are current");
    return;
  }

  const apiBase = resolveGeneratorApiBase();
  let envelope: SnapshotEnvelope | null = null;
  let depegEvents: DepegEvent[] = [];
  let depegCapture: DepegLedgerCapture | undefined;
  let asOfISO = `${snapshotDate}T00:00:00.000Z`;

  if (apiBase) {
    try {
      const liveInputs = await loadPublicDatasetLiveInputs(apiBase, requestedSnapshotDate);
      envelope = liveInputs.envelope;
      depegEvents = liveInputs.depegEvents;
      depegCapture = liveInputs.depegCapture;
      snapshotDate = liveInputs.effectiveSnapshotDate;
      asOfISO = liveInputs.asOfISO;
      if (snapshotDate !== requestedSnapshotDate) {
        console.log(
          `[generate-public-datasets] Requested snapshot ${requestedSnapshotDate} unavailable; using latest snapshot ${snapshotDate}.`,
        );
      }
    } catch (err) {
      if (preserveExistingDatasetMirrorsAfterFetchFailure(err)) {
        return;
      }
      throw err;
    }
  } else {
    if (REQUIRE_API_SOURCE) {
      throw new Error(
        "No public dataset API source configured. Set PUBLIC_DATASETS_API_URL, SMOKE_API_BASE, or API_BASE_URL; use --allow-stub only for explicit local placeholder regeneration.",
      );
    }
    if (!allowStub) {
      const existing = checkAllTopics();
      if (existing.ok) {
        console.log(
          "[generate-public-datasets] No PUBLIC_DATASETS_API_URL / SMOKE_API_BASE / API_BASE_URL set; preserving checked-in public dataset mirrors.",
        );
        return;
      }
      throw new Error(
        `No public dataset API source configured and checked-in mirrors are not current. Set PUBLIC_DATASETS_API_URL, SMOKE_API_BASE, or API_BASE_URL; use --allow-stub only for explicit local placeholder regeneration. (${existing.reason})`,
      );
    }
    console.log(
      "[generate-public-datasets] No PUBLIC_DATASETS_API_URL / SMOKE_API_BASE / API_BASE_URL set; emitting explicit stub mirrors.",
    );
  }

  const specs = buildTopicSpecs(envelope, depegEvents, snapshotDate, {
    historical: isHistoricalSnapshotDate(requestedSnapshotDate),
    depegCapture,
  });
  if (apiBase) {
    for (const spec of specs) {
      validateTopicRowFloor(spec.topic, spec.rows);
    }
  }

  ensureDir(DATASETS_DIR);

  let totalWritten = 0;
  let totalPruned = 0;
  for (const spec of specs) {
    const result = writeTopic(spec as TopicSpec<unknown>, snapshotDate, asOfISO);
    totalWritten += result.written;
    totalPruned += pruneOldSnapshots(join(DATASETS_DIR, spec.topic), snapshotDate);
  }
  const repointCurrent = !isHistoricalSnapshotDate(requestedSnapshotDate) || values["repoint-current"];
  if (repointCurrent) {
    if (writePublicDatasetRedirects(snapshotDate).changed) totalWritten += 1;
    if (writePublicDatasetCurrentModule(snapshotDate).changed) totalWritten += 1;
  } else {
    console.log(
      `[generate-public-datasets] Historical snapshot ${requestedSnapshotDate} left latest aliases unchanged; `
      + "pass --repoint-current to replace them.",
    );
  }

  console.log(
    `Generated public dataset mirrors for ${PUBLIC_DATASET_TOPICS.length} topics ` +
      `(snapshotDate=${snapshotDate}, wrote ${totalWritten}, pruned ${totalPruned}).`,
  );
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
