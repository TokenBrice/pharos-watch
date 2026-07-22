import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import {
  buildEthenaProtocolApiMeasurement,
  ETHENA_PROTOCOL_API_URLS,
  ProtocolApiMechanismMeasurementSchema,
  type ProtocolApiMechanismMeasurement,
} from "../lib/mechanism-measurement/protocol-api";

const DEFAULT_OUT_DIR = "shared/data/safety-score-v9/mechanism-measurements";
const USAGE = `Usage: npx tsx scripts/maintenance/measure-protocol-api-mechanism-metrics.ts [options]

Captures schema-validated protocol API evidence for configured synthetic/yield
mechanisms. Measurements are producer evidence only; scoring adoption remains
identity-bound.

Options:
  --out-dir <path>  Evidence root (default: ${DEFAULT_OUT_DIR})
  --replay <path>   Offline-replay an evidence artifact (repeatable; exclusive)
  -h, --help        Show this help`;

interface CliOptions {
  outDir: string;
  replayPaths: string[];
}

function parseOptions(argv: string[]): CliOptions | null {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      "out-dir": { type: "string" },
      replay: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return null;
  const replayPaths = Array.isArray(values.replay) ? values.replay.map(String) : [];
  if (replayPaths.length > 0 && values["out-dir"] != null) {
    throw new Error("--replay is exclusive with --out-dir");
  }
  return {
    outDir: typeof values["out-dir"] === "string" ? values["out-dir"] : DEFAULT_OUT_DIR,
    replayPaths,
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Pharos mechanism measurement/1" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function replayEvidence(path: string): void {
  const absolutePath = resolve(path);
  const recorded = ProtocolApiMechanismMeasurementSchema.parse(JSON.parse(readFileSync(absolutePath, "utf8")));
  const replayed = buildEthenaProtocolApiMeasurement({
    collateralizationStatus: recorded.observations.collateralizationStatus.payload,
    proofOfReserves: recorded.observations.proofOfReserves.payload,
    capturedAt: new Date(recorded.capturedAt),
  });
  if (JSON.stringify(replayed) !== JSON.stringify(recorded)) {
    throw new Error(`Offline replay diverged from recorded artifact ${absolutePath}`);
  }
  console.log(`[protocol-api-measurement] ${recorded.assetId}: offline replay passed -> ${absolutePath}`);
}

function evidenceFilename(evidence: ProtocolApiMechanismMeasurement): string {
  return `${evidence.observations.collateralizationStatus.observedAt.replaceAll(":", "-")}-protocol-api.json`;
}

async function measureEthena(outDir: string): Promise<void> {
  const [collateralizationStatus, proofOfReserves] = await Promise.all([
    fetchJson(ETHENA_PROTOCOL_API_URLS.collateralizationStatus),
    fetchJson(ETHENA_PROTOCOL_API_URLS.proofOfReserves),
  ]);
  const evidence = buildEthenaProtocolApiMeasurement({ collateralizationStatus, proofOfReserves });
  const outPath = resolve(join(outDir, evidence.assetId, evidenceFilename(evidence)));
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  mkdirSync(dirname(outPath), { recursive: true });
  try {
    writeFileSync(outPath, serialized, { flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    const existing = ProtocolApiMechanismMeasurementSchema.parse(JSON.parse(readFileSync(outPath, "utf8")));
    const existingAtCurrentCapture = { ...existing, capturedAt: evidence.capturedAt };
    if (JSON.stringify(existingAtCurrentCapture) !== JSON.stringify(evidence)) {
      throw new Error(`Evidence ${outPath} exists with different content; refusing to overwrite`);
    }
    console.log(`[protocol-api-measurement] identical evidence already recorded at ${outPath}`);
    return;
  }
  console.log(
    `[protocol-api-measurement] ${evidence.assetId}: ` +
      `CR=${evidence.derived.collateralizationRatio} reserve=${evidence.metrics.lossAbsorptionShare} ` +
      `deltaNeutral=${evidence.derived.deltaNeutralAttested} -> ${outPath}`,
  );
}

void runCliEntrypoint(
  async () => {
    const options = parseOptions(process.argv.slice(2));
    if (!options) return;
    if (options.replayPaths.length > 0) {
      for (const path of options.replayPaths) replayEvidence(path);
      return;
    }
    await measureEthena(options.outDir);
  },
  { label: "measure-protocol-api-mechanism-metrics", usage: USAGE },
);
