import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  assertCliUsage,
  CliUsageError,
  parseStrictCliArgs,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import {
  buildProtocolApiMeasurement,
  isSameProtocolApiSourceSnapshot,
  PROTOCOL_API_TARGETS,
  protocolApiEvidenceFilename,
  replayProtocolApiMeasurement,
  serializeProtocolApiMeasurement,
  validateProtocolApiArtifactSet,
  type ProtocolApiAssetId,
  type ProtocolApiMechanismMeasurement,
  type RawProtocolApiObservationInput,
} from "../lib/mechanism-measurement/protocol-api";
import {
  CAPTURE_SUMMARY_SUFFIX,
  capturePathFromSummary,
  parseMechanismCaptureSummary,
  resolveCaptureBody,
} from "../lib/mechanism-measurement/capture-summary";
import type { R2MeasurementsClient } from "../lib/r2-measurements-client";

const DEFAULT_OUT_DIR = "shared/data/safety-score-v9/mechanism-measurements";
const FROZEN_LEGACY_V1_PATH =
  "shared/data/safety-score-v9/mechanism-measurements/usde-ethena/2026-07-22T20-00-16.250Z-protocol-api.json";
const FROZEN_LEGACY_V1_SHA256 = "cdcbc2f806fcf6def97a2870d262a821ece9636efcd5a9d80c29518ae1a2589f";
const USAGE = `Usage: npx tsx scripts/maintenance/measure-protocol-api-mechanism-metrics.ts [options]

Captures permanent, non-publishing protocol API evidence. Direct score adoption
remains blocked; economic facts require human-reviewed curation.

Options:
  --asset <id>      Live target id (repeatable; required for live capture)
  --out-dir <path>  Evidence root (default: ${DEFAULT_OUT_DIR})
  --replay <path>   Strictly replay an artifact (repeatable; exclusive)
  --replay-all      Strictly replay and validate every protocol API artifact
  -h, --help        Show this help

Replay reads original local bytes or a hash-verified local cache; otherwise it
uses signed R2 GETs (pinned/ then captures/) and caches verified original bytes.
Missing access, expired objects or corrupt bytes fail replay. The single frozen
V1 exception verifies original normalized bytes, never raw-source replay.`;

interface CliOptions {
  assets: ProtocolApiAssetId[];
  outDir: string;
  replayPaths: string[];
  replayAll: boolean;
}

type ProtocolApiBodyClass = "empty" | "html-like" | "json-array" | "json-object" | "other";

interface ProtocolApiTransportProvenance {
  sourceId: string;
  configuredUrl: string;
  finalUrl: string;
  status: number;
  redirected: boolean;
  mediaType: string | null;
  bodyBytes: number;
  bodySha256: string;
  bodyClass: ProtocolApiBodyClass;
  reason: "http-error" | "non-json-media-type" | "unexpected-body-class" | null;
  headers: Record<string, string>;
}

interface FetchObservationOptions {
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

const TRANSPORT_DIAGNOSTIC_HEADERS = ["server", "x-vercel-id", "x-vercel-cache", "x-matched-path"] as const;
const MAX_DIAGNOSTIC_HEADER_LENGTH = 160;

export interface ProtocolApiMeasurementCliIo {
  log: (message: string) => void;
  error: (message: string) => void;
}

const DEFAULT_CLI_IO: ProtocolApiMeasurementCliIo = {
  log: (message) => process.stdout.write(`${message}\n`),
  error: (message) => process.stderr.write(message),
};

function parseOptions(argv: readonly string[]): CliOptions | null {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      asset: { type: "string", multiple: true },
      "out-dir": { type: "string" },
      replay: { type: "string", multiple: true },
      "replay-all": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return null;

  const rawAssets = Array.isArray(values.asset) ? values.asset.map(String) : [];
  const replayPaths = Array.isArray(values.replay) ? values.replay.map(String) : [];
  const replayAll = values["replay-all"] === true;
  const liveOptionPresent = rawAssets.length > 0 || values["out-dir"] != null;
  assertCliUsage(!(replayPaths.length > 0 && (liveOptionPresent || replayAll)), "--replay is exclusive with --asset, --out-dir, and --replay-all");
  assertCliUsage(!(replayAll && (liveOptionPresent || replayPaths.length > 0)), "--replay-all is exclusive with --asset, --out-dir, and --replay");
  assertCliUsage(replayPaths.length > 0 || replayAll || rawAssets.length > 0, "live capture requires at least one --asset");
  assertCliUsage(new Set(rawAssets).size === rawAssets.length, "--asset values must not be duplicated");
  assertCliUsage(new Set(replayPaths).size === replayPaths.length, "--replay values must not be duplicated");

  const knownAssets = Object.keys(PROTOCOL_API_TARGETS) as ProtocolApiAssetId[];
  for (const asset of rawAssets) {
    assertCliUsage(knownAssets.includes(asset as ProtocolApiAssetId), `unknown --asset ${asset} (known: ${knownAssets.join(", ")})`);
  }
  return {
    assets: rawAssets as ProtocolApiAssetId[],
    outDir: typeof values["out-dir"] === "string" ? values["out-dir"] : DEFAULT_OUT_DIR,
    replayPaths,
    replayAll,
  };
}

function sanitizeDiagnosticUrl(input: string): string {
  try {
    const url = new URL(input);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

function classifyBody(rawBody: Uint8Array): ProtocolApiBodyClass {
  let index = 0;
  while (index < rawBody.length && [0x09, 0x0a, 0x0d, 0x20].includes(rawBody[index]!)) index += 1;
  if (index === rawBody.length) return "empty";
  if (rawBody[index] === 0x7b) return "json-object";
  if (rawBody[index] === 0x5b) return "json-array";
  if (rawBody[index] === 0x3c) return "html-like";
  return "other";
}

function normalizedMediaType(response: Response): string | null {
  const value = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return value || null;
}

function isJsonMediaType(mediaType: string | null): boolean {
  return mediaType === "application/json" || (mediaType?.startsWith("application/") === true && mediaType.endsWith("+json"));
}

function diagnosticHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of TRANSPORT_DIAGNOSTIC_HEADERS) {
    const value = response.headers.get(name);
    if (!value) continue;
    headers[name] = value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, MAX_DIAGNOSTIC_HEADER_LENGTH);
  }
  return headers;
}

function transportProvenance(
  source: { sourceId: string; url: string },
  response: Response,
  rawBody: Uint8Array,
): ProtocolApiTransportProvenance {
  return {
    sourceId: source.sourceId,
    configuredUrl: sanitizeDiagnosticUrl(source.url),
    finalUrl: sanitizeDiagnosticUrl(response.url || source.url),
    status: response.status,
    redirected: response.redirected,
    mediaType: normalizedMediaType(response),
    bodyBytes: rawBody.byteLength,
    bodySha256: createHash("sha256").update(rawBody).digest("hex"),
    bodyClass: classifyBody(rawBody),
    reason: null,
    headers: diagnosticHeaders(response),
  };
}

async function fetchRawObservation(
  source: { sourceId: string; url: string },
  { fetchImpl = fetch, log = console.log }: FetchObservationOptions = {},
): Promise<RawProtocolApiObservationInput> {
  const response = await fetchImpl(source.url, {
    headers: { Accept: "application/json", "User-Agent": "Pharos protocol API mechanism measurement/2" },
    signal: AbortSignal.timeout(15_000),
  });
  const rawBody = new Uint8Array(await response.arrayBuffer());
  const provenance = transportProvenance(source, response, rawBody);
  let rejection: string | null = null;
  if (!response.ok) {
    provenance.reason = "http-error";
    rejection = `HTTP ${response.status}`;
  } else if (!isJsonMediaType(provenance.mediaType)) {
    provenance.reason = "non-json-media-type";
    rejection = "non-JSON media type";
  } else if (provenance.bodyClass !== "json-object" && provenance.bodyClass !== "json-array") {
    provenance.reason = "unexpected-body-class";
    rejection = `unexpected ${provenance.bodyClass} body`;
  }
  const serializedProvenance = JSON.stringify(provenance);
  log(`[protocol-api-measurement] transport=${serializedProvenance}`);
  if (rejection) throw new Error(`${source.sourceId} response rejected (${rejection}): ${serializedProvenance}`);

  return {
    sourceId: source.sourceId,
    url: source.url,
    rawBody,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

function discoverProtocolArtifacts(root: string): string[] {
  const paths: string[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(CAPTURE_SUMMARY_SUFFIX) && entry.name.includes("-protocol-api.")) {
        paths.push(capturePathFromSummary(path));
      } else if (
        entry.isFile() &&
        entry.name.endsWith("-protocol-api.json") &&
        !existsSync(`${path.slice(0, -".json".length)}${CAPTURE_SUMMARY_SUFFIX}`)
      ) {
        paths.push(path);
      }
    }
  }

  const absoluteRoot = resolve(root);
  for (const assetId of Object.keys(PROTOCOL_API_TARGETS) as ProtocolApiAssetId[]) {
    try {
      visit(join(absoluteRoot, assetId));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return paths.sort();
}

export type ProtocolApiArchiveResult =
  | { status: "verified-v2"; artifact: ProtocolApiMechanismMeasurement }
  | { status: "verified-normalized-v1"; schemaVersion: 1 }
  | { status: "unavailable"; schemaVersion: number | null; reason: string; frozenV1MetadataRecognized: boolean };

export async function readProtocolApiArtifact(
  path: string,
  r2Client?: R2MeasurementsClient,
  rootDir: string = process.cwd(),
): Promise<ProtocolApiArchiveResult> {
  const absolutePath = resolve(rootDir, path);
  const summaryPath = `${absolutePath.slice(0, -".json".length)}${CAPTURE_SUMMARY_SUFFIX}`;
  let schemaVersion: number | null = null;
  let summarySha256: string | null = null;
  let frozenV1MetadataRecognized = false;
  if (existsSync(summaryPath)) {
    const summary = parseMechanismCaptureSummary(JSON.parse(readFileSync(summaryPath, "utf8")), summaryPath);
    schemaVersion = typeof summary.summary.schemaVersion === "number" ? summary.summary.schemaVersion : null;
    summarySha256 = summary.sha256;
    if (absolutePath === resolve(rootDir, FROZEN_LEGACY_V1_PATH)) {
      if (summary.sha256 !== FROZEN_LEGACY_V1_SHA256 || schemaVersion !== 1) {
        throw new Error(`Unknown or modified legacy protocol API artifact: ${absolutePath}`);
      }
      frozenV1MetadataRecognized = true;
    }
  }
  let sourceBytes: Buffer;
  try {
    sourceBytes = await resolveCaptureBody(absolutePath, {
      missingCaptureLabel: "protocol API",
      r2Client,
      rootDir,
    });
  } catch (error) {
    return {
      status: "unavailable",
      schemaVersion,
      reason: error instanceof Error ? error.message : String(error),
      frozenV1MetadataRecognized,
    };
  }
  const fingerprint = createHash("sha256").update(sourceBytes).digest("hex");
  if (summarySha256 !== null && fingerprint !== summarySha256) {
    throw new Error(absolutePath === resolve(rootDir, FROZEN_LEGACY_V1_PATH)
      ? `Unknown or modified legacy protocol API artifact: ${absolutePath}`
      : `Protocol API capture ${summarySha256} integrity mismatch: ${absolutePath}`);
  }
  const source = sourceBytes.toString("utf8");
  const parsed = JSON.parse(source) as unknown;
  if (parsed && typeof parsed === "object" && "schemaVersion" in parsed && parsed.schemaVersion === 1) {
    if (absolutePath !== resolve(rootDir, FROZEN_LEGACY_V1_PATH) || fingerprint !== FROZEN_LEGACY_V1_SHA256) {
      throw new Error(`Unknown or modified legacy protocol API artifact: ${absolutePath}`);
    }
    return { status: "verified-normalized-v1", schemaVersion: 1 };
  }
  const replayed = replayProtocolApiMeasurement(parsed);
  if (serializeProtocolApiMeasurement(replayed) !== source) {
    throw new Error(`Protocol API artifact is not canonical: ${absolutePath}`);
  }
  return { status: "verified-v2", artifact: replayed };
}

async function replayEvidence(
  path: string,
  io: ProtocolApiMeasurementCliIo = DEFAULT_CLI_IO,
  rootDir: string = process.cwd(),
): Promise<ProtocolApiArchiveResult> {
  const absolutePath = resolve(rootDir, path);
  const result = await readProtocolApiArtifact(absolutePath, undefined, rootDir);
  if (result.status === "unavailable") {
    io.error(`[protocol-api-measurement] unavailable schema=${result.schemaVersion ?? "unknown"} frozen-V1-metadata=${result.frozenV1MetadataRecognized}: ${result.reason} -> ${absolutePath}\n`);
  } else if (result.status === "verified-normalized-v1") {
    io.log(`[protocol-api-measurement] frozen legacy V1 original-byte fingerprint passed (normalized-only; raw replay unavailable) -> ${absolutePath}`);
  } else {
    io.log(`[protocol-api-measurement] ${result.artifact.assetId}: offline raw-byte replay passed -> ${absolutePath}`);
  }
  return result;
}

async function acceptExistingSnapshot(
  path: string,
  incoming: ProtocolApiMechanismMeasurement,
  io: ProtocolApiMeasurementCliIo = DEFAULT_CLI_IO,
  rootDir: string = process.cwd(),
): Promise<boolean> {
  try {
    const result = await readProtocolApiArtifact(path, undefined, rootDir);
    if (result.status === "unavailable") throw new Error(result.reason);
    if (result.status !== "verified-v2") throw new Error(`Legacy V1 evidence cannot occupy a V2 snapshot path: ${path}`);
    if (!isSameProtocolApiSourceSnapshot(result.artifact, incoming)) {
      throw new Error(`Evidence ${path} exists with different source content or derivation`);
    }
    io.log(`[protocol-api-measurement] identical source snapshot already recorded at ${path}`);
    return true;
  } catch (error) {
    if (error instanceof Error && (error.message.includes("ENOENT") || error.message.startsWith("Missing protocol API"))) {
      return false;
    }
    throw error;
  }
}

async function existingArtifacts(outDir: string): Promise<ProtocolApiMechanismMeasurement[]> {
  try {
    const artifacts: ProtocolApiMechanismMeasurement[] = [];
    for (const path of discoverProtocolArtifacts(outDir)) {
      const result = await readProtocolApiArtifact(path);
      if (result.status === "unavailable") throw new Error(result.reason);
      if (result.status === "verified-v2") artifacts.push(result.artifact);
    }
    return artifacts;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
async function measureTarget(
  outDir: string,
  assetId: ProtocolApiAssetId,
  io: ProtocolApiMeasurementCliIo = DEFAULT_CLI_IO,
): Promise<void> {
  const target = PROTOCOL_API_TARGETS[assetId];
  const observations: RawProtocolApiObservationInput[] = [];
  for (const source of target.sources) observations.push(await fetchRawObservation(source));
  const artifact = buildProtocolApiMeasurement(assetId, observations);
  replayProtocolApiMeasurement(artifact);

  const outPath = resolve(join(outDir, assetId, protocolApiEvidenceFilename(artifact)));
  try {
    if (await acceptExistingSnapshot(outPath, artifact, io)) return;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }

  validateProtocolApiArtifactSet([...(await existingArtifacts(outDir)), artifact]);
  mkdirSync(dirname(outPath), { recursive: true });
  try {
    writeFileSync(outPath, serializeProtocolApiMeasurement(artifact), { flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    await acceptExistingSnapshot(outPath, artifact, io);
    return;
  }

  const measured = Object.fromEntries(
    artifact.metrics.filter((metric) => metric.state === "measured").map((metric) => [metric.id, metric.value]),
  );
  io.log(
    `[protocol-api-measurement] ${assetId}: snapshot=${artifact.snapshotId} metrics=${JSON.stringify(measured)} -> ${outPath}`,
  );
}

/**
 * In-process entrypoint with the CLI's process semantics: usage mistakes
 * report 2, runtime failures report 1, success reports 0. `cwd` scopes the
 * relative `--replay` paths, the frozen legacy artifact comparison, and
 * `--replay-all` discovery, so tests can drive scratch roots without a child
 * process; the direct-run block below stays the real-process owner of the
 * exit contract.
 */
export async function runProtocolApiMeasurementCli(
  argv: readonly string[],
  io: ProtocolApiMeasurementCliIo = DEFAULT_CLI_IO,
  cwd: string = process.cwd(),
): Promise<number> {
  try {
    const options = parseOptions([...argv]);
    if (!options) return 0;
    if (options.replayPaths.length > 0 || options.replayAll) {
      const paths = options.replayAll
        ? discoverProtocolArtifacts(resolve(cwd, DEFAULT_OUT_DIR))
        : options.replayPaths;
      const artifacts: ProtocolApiMechanismMeasurement[] = [];
      let normalizedV1Count = 0;
      let unavailableCount = 0;
      for (const path of paths) {
        const result = await replayEvidence(path, io, cwd);
        if (result.status === "verified-v2") artifacts.push(result.artifact);
        else if (result.status === "verified-normalized-v1") normalizedV1Count += 1;
        else unavailableCount += 1;
      }
      validateProtocolApiArtifactSet(artifacts);
      io.log(
        `[protocol-api-measurement] ${options.replayAll ? "replay-all" : "replay"} ${unavailableCount > 0 ? "incomplete" : "passed"}: ${artifacts.length} verified V2 artifact(s), ${normalizedV1Count} hash-verified normalized-only V1 artifact(s), ${unavailableCount} unavailable artifact(s)`,
      );
      return unavailableCount > 0 ? 1 : 0;
    }
    for (const asset of options.assets) await measureTarget(options.outDir, asset, io);
    return 0;
  } catch (error) {
    const usageError = error instanceof CliUsageError;
    const message = error instanceof Error ? error.message : String(error);
    io.error(`measure-protocol-api-mechanism-metrics: ${message}\n`);
    if (usageError) io.error(`\n${USAGE.trimEnd()}\n`);
    return usageError ? 2 : 1;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runProtocolApiMeasurementCli(process.argv.slice(2)).then((status) => {
    if (status !== 0) process.exitCode = status;
  });
}

export { fetchRawObservation as fetchProtocolApiObservation, parseOptions as parseProtocolApiCliOptions };
