import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseCliInteger, parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { parseEvidenceProducerMode, runEvidenceProducer } from "../lib/measurement-evidence-runner";
import { fetchBlockByNumber, pinBlock, JournaledEthCaller, ReplayEthCaller } from "../lib/mechanism-measurement/core";
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
  const mode = parseEvidenceProducerMode(values, "shared/data/safety-score-v9/mechanism-measurements");
  if (
    mode.replayPaths.length > 0 &&
    (mode.assets.length > 0 || values.rpc != null || values.block != null || values["out-dir"] != null)
  ) {
    throw new Error("--replay is exclusive with --asset, --rpc, --block, and --out-dir");
  }
  return {
    ...mode,
    rpc: typeof values.rpc === "string" ? values.rpc : null,
    block,
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
  const recorded = MechanismMeasurementEvidenceV1Schema.parse(JSON.parse(readFileSync(absolutePath, "utf8")));
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

async function run(options: CliOptions): Promise<void> {
  await runEvidenceProducer({
    options,
    configuredAssets: CDP_MEASUREMENT_TARGETS.map((target) => target.assetId),
    resolveTarget: (assetId) => CDP_MEASUREMENT_TARGETS.find((candidate) => candidate.assetId === assetId),
    unknownTargetError: (assetId) =>
      `No measurement target configured for ${assetId} (known: ${CDP_MEASUREMENT_TARGETS.map((t) => t.assetId).join(", ")})`,
    replay: replayEvidence,
    attempts: (target) => options.rpc ? [options.rpc] : target.rpcs,
    capture: async (target, rpcUrl) => {
      const endpoint = rpcUrl as string;
      const block = options.block == null ? await pinBlock(endpoint) : await fetchBlockByNumber(endpoint, options.block);
      const caller = new JournaledEthCaller(endpoint, `0x${block.number.toString(16)}`);
      const evidenceRpcUrl = redactRpcUrlForEvidence(endpoint);
      const evidence = await measureConfiguredTarget(caller, target, block, evidenceRpcUrl);
      return MechanismMeasurementEvidenceV1Schema.parse(evidence);
    },
    artifactPath: (evidence) => {
      const date = evidence.block.timestampIso.slice(0, 10);
      return join(options.outDir, evidence.assetId, `${date}-block-${evidence.block.number}.json`);
    },
    serialize: (evidence) => `${JSON.stringify(evidence, null, 2)}\n`,
    compareExisting: (outPath, evidence) => {
      const existing = readFileSync(outPath, "utf8");
      // rpcUrl and block.selection describe how THIS run reached the block,
      // not what was measured; everything else must replay byte-identically.
      if (measurementOnly(JSON.parse(existing)) !== measurementOnly(evidence)) {
        throw new Error(
          `Evidence file ${outPath} already exists with a different measurement — refusing to overwrite`,
        );
      }
    },
    onExisting: ({ evidence, outPath }) => {
      console.log(`[measure-cdp] ${evidence.assetId}: identical measurement already recorded at ${outPath}`);
    },
    onWritten: ({ evidence, outPath }) => {
      const completeness = evidence.completeness ?? { complete: true, blockers: [] };
      const formatMetric = (value: number | null): string => (value === null ? "N/A" : String(value));
      console.log(
        `[measure-cdp] ${evidence.assetId}: block ${evidence.block.number} (${evidence.block.selection}) via ${evidence.rpcUrl}\n` +
          `  collateralizationRatio=${formatMetric(evidence.metrics.collateralizationRatio)} liquidationCapacityRatio=${formatMetric(evidence.metrics.liquidationCapacityRatio)}\n` +
          `  complete=${completeness.complete}${completeness.blockers.length > 0 ? ` blockers=${completeness.blockers.join(" | ")}` : ""}\n` +
          `  checks=${evidence.checks.length} pass -> ${outPath}`,
      );
    },
    onAttemptError: (error, assetId, rpcUrl) => {
      console.warn(
        `[measure-cdp] ${assetId}: ${redactRpcUrlForEvidence(rpcUrl)} failed — ${error instanceof Error ? error.message : String(error)}`,
      );
    },
    attemptsFailedError: (error, assetId) =>
      `All RPC endpoints failed for ${assetId}: ${error instanceof Error ? error.message : String(error)}`,
  });
}

void runCliEntrypoint(
  async () => {
    const options = parseOptions(process.argv.slice(2));
    if (!options) return;
    await run(options);
  },
  { label: "measure-cdp-mechanism-metrics", usage: USAGE },
);
