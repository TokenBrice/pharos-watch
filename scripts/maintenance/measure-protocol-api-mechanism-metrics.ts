import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  assertCliUsage,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { parseEvidenceProducerMode, runEvidenceProducer } from "../lib/measurement-evidence-runner";
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

const DEFAULT_OUT_DIR = "shared/data/safety-score-v9/mechanism-measurements";
const FROZEN_LEGACY_V1_PATH =
  "shared/data/safety-score-v9/mechanism-measurements/usde-ethena/2026-07-22T20-00-16.250Z-protocol-api.json";
const FROZEN_LEGACY_V1_SHA256 = "cdcbc2f806fcf6def97a2870d262a821ece9636efcd5a9d80c29518ae1a2589f";
const USAGE = `Usage: npx tsx scripts/maintenance/measure-protocol-api-mechanism-metrics.ts [options]

Captures raw-byte, schema-validated protocol API mechanism evidence. These
measurements are producer evidence only; score adoption remains identity-bound.

Options:
  --asset <id>      Live target id (repeatable; required for live capture)
  --out-dir <path>  Evidence root (default: ${DEFAULT_OUT_DIR})
  --replay <path>   Offline-replay an artifact (repeatable; exclusive)
  --replay-all      Replay and validate every protocol API artifact in the evidence root
  -h, --help        Show this help`;

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
  headers: Record<string, string>;
}

interface FetchObservationOptions {
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

const TRANSPORT_DIAGNOSTIC_HEADERS = ["server", "x-vercel-id", "x-vercel-cache", "x-matched-path"] as const;
const MAX_DIAGNOSTIC_HEADER_LENGTH = 160;

function parseOptions(argv: string[]): CliOptions | null {
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

  const mode = parseEvidenceProducerMode<ProtocolApiAssetId>(values, DEFAULT_OUT_DIR);
  const replayAll = values["replay-all"] === true;
  const liveOptionPresent = mode.assets.length > 0 || values["out-dir"] != null;
  assertCliUsage(!(mode.replayPaths.length > 0 && (liveOptionPresent || replayAll)), "--replay is exclusive with --asset, --out-dir, and --replay-all");
  assertCliUsage(!(replayAll && (liveOptionPresent || mode.replayPaths.length > 0)), "--replay-all is exclusive with --asset, --out-dir, and --replay");
  assertCliUsage(mode.replayPaths.length > 0 || replayAll || mode.assets.length > 0, "live capture requires at least one --asset");
  assertCliUsage(new Set(mode.assets).size === mode.assets.length, "--asset values must not be duplicated");
  assertCliUsage(new Set(mode.replayPaths).size === mode.replayPaths.length, "--replay values must not be duplicated");

  const knownAssets = Object.keys(PROTOCOL_API_TARGETS) as ProtocolApiAssetId[];
  for (const asset of mode.assets) {
    assertCliUsage(knownAssets.includes(asset as ProtocolApiAssetId), `unknown --asset ${asset} (known: ${knownAssets.join(", ")})`);
  }
  return {
    ...mode,
    replayAll,
  };
}

function sanitizeDiagnosticUrl(input: string): string {
  try {
    const url = new URL(input);
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
  const serializedProvenance = JSON.stringify(provenance);
  log(`[protocol-api-measurement] transport=${serializedProvenance}`);

  let rejection: string | null = null;
  if (!response.ok) rejection = `HTTP ${response.status}`;
  else if (!isJsonMediaType(provenance.mediaType)) rejection = "non-JSON media type";
  else if (provenance.bodyClass !== "json-object" && provenance.bodyClass !== "json-array") {
    rejection = `unexpected ${provenance.bodyClass} body`;
  }
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
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith("-protocol-api.json")) paths.push(path);
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

function readArtifact(path: string): ProtocolApiMechanismMeasurement | null {
  const absolutePath = resolve(path);
  const source = readFileSync(absolutePath, "utf8");
  const parsed = JSON.parse(source) as unknown;
  if (parsed && typeof parsed === "object" && "schemaVersion" in parsed && parsed.schemaVersion === 1) {
    const fingerprint = createHash("sha256").update(source).digest("hex");
    if (absolutePath !== resolve(FROZEN_LEGACY_V1_PATH) || fingerprint !== FROZEN_LEGACY_V1_SHA256) {
      throw new Error(`Unknown or modified legacy protocol API artifact: ${absolutePath}`);
    }
    console.log(
      `[protocol-api-measurement] frozen legacy V1 fingerprint passed (normalized-only; raw replay unavailable) -> ${absolutePath}`,
    );
    return null;
  }
  const replayed = replayProtocolApiMeasurement(parsed);
  if (serializeProtocolApiMeasurement(replayed) !== source) {
    throw new Error(`Protocol API artifact is not canonical: ${absolutePath}`);
  }
  return replayed;
}

function replayEvidence(path: string): ProtocolApiMechanismMeasurement | null {
  const absolutePath = resolve(path);
  const replayed = readArtifact(absolutePath);
  if (!replayed) return null;
  console.log(`[protocol-api-measurement] ${replayed.assetId}: offline raw-byte replay passed -> ${absolutePath}`);
  return replayed;
}

function assertExistingSnapshot(path: string, incoming: ProtocolApiMechanismMeasurement): void {
  const existing = readArtifact(path);
  if (!existing) throw new Error(`Legacy V1 evidence cannot occupy a V2 snapshot path: ${path}`);
  if (!isSameProtocolApiSourceSnapshot(existing, incoming)) {
    throw new Error(`Evidence ${path} exists with different source content or derivation`);
  }
}

function existingArtifacts(outDir: string): unknown[] {
  try {
    return discoverProtocolArtifacts(outDir)
      .map(readArtifact)
      .filter((artifact): artifact is ProtocolApiMechanismMeasurement => artifact !== null);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function run(options: CliOptions): Promise<void> {
  const configuredAssets = Object.keys(PROTOCOL_API_TARGETS) as ProtocolApiAssetId[];
  await runEvidenceProducer({
    options,
    configuredAssets,
    resolveTarget: (assetId) => PROTOCOL_API_TARGETS[assetId],
    unknownTargetError: (assetId) => `unknown --asset ${assetId} (known: ${configuredAssets.join(", ")})`,
    replay: replayEvidence,
    afterReplay: (artifacts) => {
      validateProtocolApiArtifactSet(
        artifacts.filter((artifact): artifact is ProtocolApiMechanismMeasurement => artifact !== null),
      );
    },
    capture: async (target, _attempt, _options, assetId) => {
      const observations: RawProtocolApiObservationInput[] = [];
      for (const source of target.sources) observations.push(await fetchRawObservation(source));
      const artifact = buildProtocolApiMeasurement(assetId, observations);
      replayProtocolApiMeasurement(artifact);
      return artifact;
    },
    artifactPath: (artifact) => join(options.outDir, artifact.assetId, protocolApiEvidenceFilename(artifact)),
    serialize: serializeProtocolApiMeasurement,
    compareExisting: assertExistingSnapshot,
    onExisting: ({ outPath }) => {
      console.log(`[protocol-api-measurement] identical source snapshot already recorded at ${outPath}`);
    },
    beforeWrite: ({ evidence }) => {
      validateProtocolApiArtifactSet([...existingArtifacts(options.outDir), evidence]);
    },
    exclusiveWrite: true,
    onWritten: ({ assetId, evidence, outPath }) => {
      const measured = Object.fromEntries(
        evidence.metrics.filter((metric) => metric.state === "measured").map((metric) => [metric.id, metric.value]),
      );
      console.log(
        `[protocol-api-measurement] ${assetId}: snapshot=${evidence.snapshotId} metrics=${JSON.stringify(measured)} -> ${outPath}`,
      );
    },
  });
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(
    async () => {
      const options = parseOptions(process.argv.slice(2));
      if (!options) return;
      if (options.replayAll) {
        const paths = discoverProtocolArtifacts(DEFAULT_OUT_DIR);
        const artifacts = paths
          .map(readArtifact)
          .filter((artifact): artifact is ProtocolApiMechanismMeasurement => artifact !== null);
        validateProtocolApiArtifactSet(artifacts);
        console.log(
          `[protocol-api-measurement] replay-all passed: ${artifacts.length} V2 artifact(s), ${paths.length - artifacts.length} frozen legacy V1 artifact(s)`,
        );
        return;
      }
      await run(options);
    },
    { label: "measure-protocol-api-mechanism-metrics", usage: USAGE },
  );
}

export { fetchRawObservation as fetchProtocolApiObservation, parseOptions as parseProtocolApiCliOptions };
