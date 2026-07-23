import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  assertCliUsage,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
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

async function fetchRawObservation(source: {
  sourceId: string;
  url: string;
}): Promise<RawProtocolApiObservationInput> {
  const response = await fetch(source.url, {
    headers: { Accept: "application/json", "User-Agent": "Pharos protocol API mechanism measurement/2" },
    signal: AbortSignal.timeout(15_000),
  });
  const rawBody = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) throw new Error(`${source.url} returned HTTP ${response.status}`);
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
  visit(resolve(root));
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

function acceptExistingSnapshot(path: string, incoming: ProtocolApiMechanismMeasurement): boolean {
  try {
    const existing = readArtifact(path);
    if (!existing) throw new Error(`Legacy V1 evidence cannot occupy a V2 snapshot path: ${path}`);
    if (!isSameProtocolApiSourceSnapshot(existing, incoming)) {
      throw new Error(`Evidence ${path} exists with different source content or derivation`);
    }
    console.log(`[protocol-api-measurement] identical source snapshot already recorded at ${path}`);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return false;
    throw error;
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

async function measureTarget(outDir: string, assetId: ProtocolApiAssetId): Promise<void> {
  const target = PROTOCOL_API_TARGETS[assetId];
  const observations: RawProtocolApiObservationInput[] = [];
  for (const source of target.sources) observations.push(await fetchRawObservation(source));
  const artifact = buildProtocolApiMeasurement(assetId, observations);
  replayProtocolApiMeasurement(artifact);

  const outPath = resolve(join(outDir, assetId, protocolApiEvidenceFilename(artifact)));
  try {
    if (acceptExistingSnapshot(outPath, artifact)) return;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }

  validateProtocolApiArtifactSet([...existingArtifacts(outDir), artifact]);
  mkdirSync(dirname(outPath), { recursive: true });
  try {
    writeFileSync(outPath, serializeProtocolApiMeasurement(artifact), { flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    acceptExistingSnapshot(outPath, artifact);
    return;
  }

  const measured = Object.fromEntries(
    artifact.metrics.filter((metric) => metric.state === "measured").map((metric) => [metric.id, metric.value]),
  );
  console.log(
    `[protocol-api-measurement] ${assetId}: snapshot=${artifact.snapshotId} metrics=${JSON.stringify(measured)} -> ${outPath}`,
  );
}

void runCliEntrypoint(
  async () => {
    const options = parseOptions(process.argv.slice(2));
    if (!options) return;
    if (options.replayPaths.length > 0) {
      const artifacts = options.replayPaths
        .map(replayEvidence)
        .filter((artifact): artifact is ProtocolApiMechanismMeasurement => artifact !== null);
      validateProtocolApiArtifactSet(artifacts);
      return;
    }
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
    for (const asset of options.assets) await measureTarget(options.outDir, asset);
  },
  { label: "measure-protocol-api-mechanism-metrics", usage: USAGE },
);

export { parseOptions as parseProtocolApiCliOptions };
