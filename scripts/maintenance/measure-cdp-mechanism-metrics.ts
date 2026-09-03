import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseCliInteger, parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { fetchBlockByNumber, pinBlock, JournaledEthCaller, ReplayEthCaller } from "../lib/mechanism-measurement/core";
import { CAPTURE_SUMMARY_SUFFIX, parseMechanismCaptureSummary } from "../lib/mechanism-measurement/capture-summary";
import { createR2MeasurementsClient } from "../lib/r2-measurements-client";
import type { R2MeasurementsClient } from "../lib/r2-measurements-client";
import { measureConfiguredTarget } from "../lib/mechanism-measurement/measure";
import { MechanismMeasurementEvidenceV1Schema } from "../lib/mechanism-measurement/schema";
import { redactRpcUrlForEvidence } from "../lib/mechanism-measurement/rpc-provenance";
import { CDP_MEASUREMENT_TARGETS } from "../lib/mechanism-measurement/targets";

const USAGE = `Usage: npx tsx scripts/maintenance/measure-cdp-mechanism-metrics.ts --asset <id> [options]

Measures CDP mechanism-review metrics (collateralization ratio, liquidation
capacity) from direct on-chain reads at a pinned block and writes an
append-only, schema-validated evidence file for overlay curation.

Options:
  --asset <id>      Target asset id (repeatable; default: every configured target)
  --rpc <url>       Override the RPC endpoint list with a single endpoint
  --block <number>  Measure at an explicit historical block instead of the finalized head
  --out-dir <path>  Evidence root (default: shared/data/safety-score-v9/mechanism-measurements)
  --replay <path>   Offline byte-replay an evidence artifact (repeatable; exclusive with live options)
  -h, --help        Show this help`;

interface CliOptions {
  assets: string[];
  rpc: string | null;
  block: number | null;
  outDir: string;
  replayPaths: string[];
}

const DEFAULT_CAPTURE_CACHE_DIR = resolve(process.cwd(), "agents/.cache/measurements");

function captureSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeCaptureBody(bytes: Uint8Array): Buffer {
  const body = Buffer.from(bytes);
  return body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body;
}

export async function resolveCaptureBody(
  path: string,
  options: { cacheDir?: string; r2Client?: R2MeasurementsClient } = {},
): Promise<Buffer> {
  const absolutePath = resolve(path);
  if (existsSync(absolutePath)) return readFileSync(absolutePath);
  const summaryPath = absolutePath.endsWith(CAPTURE_SUMMARY_SUFFIX)
    ? absolutePath
    : `${absolutePath.slice(0, -".json".length)}${CAPTURE_SUMMARY_SUFFIX}`;
  if (!existsSync(summaryPath)) throw new Error(`Missing mechanism evidence capture or summary: ${absolutePath}`);
  const summary = parseMechanismCaptureSummary(JSON.parse(readFileSync(summaryPath, "utf8")), summaryPath);
  const cacheDir = resolve(options.cacheDir ?? DEFAULT_CAPTURE_CACHE_DIR);
  const cachePath = resolve(cacheDir, `${summary.sha256}.json`);
  if (existsSync(cachePath)) {
    const cached = readFileSync(cachePath);
    if (captureSha256(cached) !== summary.sha256) throw new Error(`capture ${summary.sha256} integrity mismatch`);
    return cached;
  }
  const client = options.r2Client ?? createR2MeasurementsClient();
  for (const key of [summary.r2Key.replace(/^captures\//u, "pinned/"), summary.r2Key]) {
    const compressed = await client.get(key);
    if (!compressed) continue;
    const body = decodeCaptureBody(compressed);
    if (captureSha256(body) !== summary.sha256) throw new Error(`capture ${summary.sha256} integrity mismatch`);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, body);
    return body;
  }
  throw new Error(`capture ${summary.sha256} expired: non-replayable`);
}

function parseOptions(argv: string[]): CliOptions | null {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      asset: { type: "string", multiple: true },
      rpc: { type: "string" },
      block: { type: "string" },
      "out-dir": { type: "string" },
      replay: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return null;
  const block = values.block == null ? null : parseCliInteger(values.block, { name: "--block", min: 1 });
  const assets = Array.isArray(values.asset) ? values.asset.map(String) : [];
  const replayPaths = Array.isArray(values.replay) ? values.replay.map(String) : [];
  if (
    replayPaths.length > 0 &&
    (assets.length > 0 || values.rpc != null || values.block != null || values["out-dir"] != null)
  ) {
    throw new Error("--replay is exclusive with --asset, --rpc, --block, and --out-dir");
  }
  return {
    assets,
    rpc: typeof values.rpc === "string" ? values.rpc : null,
    block,
    outDir:
      typeof values["out-dir"] === "string" ? values["out-dir"] : "shared/data/safety-score-v9/mechanism-measurements",
    replayPaths,
  };
}

function measurementOnly(value: unknown): string {
  const cloned = structuredClone(value) as { rpcUrl?: string; block?: { selection?: string } };
  delete cloned.rpcUrl;
  if (cloned.block) delete cloned.block.selection;
  return JSON.stringify(cloned);
}

async function replayEvidence(path: string): Promise<void> {
  const absolutePath = resolve(path);
  const recorded = MechanismMeasurementEvidenceV1Schema.parse(
    JSON.parse((await resolveCaptureBody(absolutePath)).toString("utf8")),
  );
  const target = CDP_MEASUREMENT_TARGETS.find((candidate) => candidate.assetId === recorded.assetId);
  if (!target) throw new Error(`No configured target for replay asset ${recorded.assetId}`);
  if (target.family !== recorded.family) {
    throw new Error(
      `Replay family mismatch for ${recorded.assetId}: target=${target.family}, artifact=${recorded.family}`,
    );
  }
  const caller = new ReplayEthCaller(recorded.calls, recorded.logQueries ?? []);
  const recomputed = MechanismMeasurementEvidenceV1Schema.parse(
    await measureConfiguredTarget(caller, target, recorded.block, recorded.rpcUrl),
  );
  caller.assertExhausted();
  if (JSON.stringify(recomputed) !== JSON.stringify(recorded)) {
    throw new Error(`Offline replay diverged from recorded artifact ${absolutePath}`);
  }
  console.log(
    `[measure-cdp] ${recorded.assetId}: offline byte replay passed (${recorded.calls.length} calls, ${recorded.logQueries?.length ?? 0} log queries) -> ${absolutePath}`,
  );
}

async function measureTarget(options: CliOptions, assetId: string): Promise<void> {
  const target = CDP_MEASUREMENT_TARGETS.find((candidate) => candidate.assetId === assetId);
  if (!target) {
    throw new Error(
      `No measurement target configured for ${assetId} (known: ${CDP_MEASUREMENT_TARGETS.map((t) => t.assetId).join(", ")})`,
    );
  }
  const rpcs = options.rpc ? [options.rpc] : target.rpcs;
  let lastError: unknown = null;
  for (const rpcUrl of rpcs) {
    try {
      const block = options.block == null ? await pinBlock(rpcUrl) : await fetchBlockByNumber(rpcUrl, options.block);
      const caller = new JournaledEthCaller(rpcUrl, `0x${block.number.toString(16)}`);
      const evidenceRpcUrl = redactRpcUrlForEvidence(rpcUrl);
      const evidence = await measureConfiguredTarget(caller, target, block, evidenceRpcUrl);
      const parsed = MechanismMeasurementEvidenceV1Schema.parse(evidence);

      const date = parsed.block.timestampIso.slice(0, 10);
      const outPath = resolve(join(options.outDir, parsed.assetId, `${date}-block-${parsed.block.number}.json`));
      const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
      if (existsSync(outPath)) {
        const existing = readFileSync(outPath, "utf8");
        // rpcUrl and block.selection describe how THIS run reached the block,
        // not what was measured; everything else must replay byte-identically.
        if (measurementOnly(JSON.parse(existing)) !== measurementOnly(parsed)) {
          throw new Error(
            `Evidence file ${outPath} already exists with a different measurement — refusing to overwrite`,
          );
        }
        console.log(`[measure-cdp] ${parsed.assetId}: identical measurement already recorded at ${outPath}`);
        return;
      }
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, serialized);
      const completeness = parsed.completeness ?? { complete: true, blockers: [] };
      const formatMetric = (value: number | null): string => (value === null ? "N/A" : String(value));
      console.log(
        `[measure-cdp] ${parsed.assetId}: block ${parsed.block.number} (${parsed.block.selection}) via ${parsed.rpcUrl}\n` +
          `  collateralizationRatio=${formatMetric(parsed.metrics.collateralizationRatio)} liquidationCapacityRatio=${formatMetric(parsed.metrics.liquidationCapacityRatio)}\n` +
          `  complete=${completeness.complete}${completeness.blockers.length > 0 ? ` blockers=${completeness.blockers.join(" | ")}` : ""}\n` +
          `  checks=${parsed.checks.length} pass -> ${outPath}`,
      );
      return;
    } catch (error) {
      lastError = error;
      console.warn(
        `[measure-cdp] ${assetId}: ${redactRpcUrlForEvidence(rpcUrl)} failed — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `All RPC endpoints failed for ${assetId}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
if (isDirectRun(import.meta.url, process.argv[1])) {

void runCliEntrypoint(
  async () => {
    const options = parseOptions(process.argv.slice(2));
    if (!options) return;
    if (options.replayPaths.length > 0) {
      for (const path of options.replayPaths) await replayEvidence(path);
      return;
    }
    const assetIds =
      options.assets.length > 0 ? options.assets : CDP_MEASUREMENT_TARGETS.map((target) => target.assetId);
    for (const assetId of assetIds) {
      await measureTarget(options, assetId);
    }
  },
  { label: "measure-cdp-mechanism-metrics", usage: USAGE },
);
}
