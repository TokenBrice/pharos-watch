import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  parseCliInteger,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { fetchBlockByNumber, pinBlock, JournaledEthCaller } from "../lib/mechanism-measurement/core";
import { measureLiquityV1 } from "../lib/mechanism-measurement/families/liquity-v1";
import { measureLiquityV2 } from "../lib/mechanism-measurement/families/liquity-v2";
import { MechanismMeasurementEvidenceV1Schema } from "../lib/mechanism-measurement/schema";
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
  -h, --help        Show this help`;

interface CliOptions {
  assets: string[];
  rpc: string | null;
  block: number | null;
  outDir: string;
}

function parseOptions(argv: string[]): CliOptions | null {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      asset: { type: "string", multiple: true },
      rpc: { type: "string" },
      block: { type: "string" },
      "out-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return null;
  const block = values.block == null ? null : parseCliInteger(values.block, { name: "--block", min: 1 });
  const assets = Array.isArray(values.asset) ? values.asset.map(String) : [];
  return {
    assets,
    rpc: typeof values.rpc === "string" ? values.rpc : null,
    block,
    outDir: typeof values["out-dir"] === "string" ? values["out-dir"] : "shared/data/safety-score-v9/mechanism-measurements",
  };
}

async function measureTarget(options: CliOptions, assetId: string): Promise<void> {
  const target = CDP_MEASUREMENT_TARGETS.find((candidate) => candidate.assetId === assetId);
  if (!target) {
    throw new Error(`No measurement target configured for ${assetId} (known: ${CDP_MEASUREMENT_TARGETS.map((t) => t.assetId).join(", ")})`);
  }
  const rpcs = options.rpc ? [options.rpc] : target.rpcs;
  let lastError: unknown = null;
  for (const rpcUrl of rpcs) {
    try {
      const block = options.block == null ? await pinBlock(rpcUrl) : await fetchBlockByNumber(rpcUrl, options.block);
      const caller = new JournaledEthCaller(rpcUrl, `0x${block.number.toString(16)}`);
      const evidence =
        target.family === "liquity-v2"
          ? await measureLiquityV2(caller, target, block, rpcUrl)
          : await measureLiquityV1(caller, target, block, rpcUrl);
      const parsed = MechanismMeasurementEvidenceV1Schema.parse(evidence);

      const date = parsed.block.timestampIso.slice(0, 10);
      const outPath = resolve(join(options.outDir, parsed.assetId, `${date}-block-${parsed.block.number}.json`));
      const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
      if (existsSync(outPath)) {
        const existing = readFileSync(outPath, "utf8");
        // rpcUrl and block.selection describe how THIS run reached the block,
        // not what was measured; everything else must replay byte-identically.
        const measurementOnly = (raw: string): string => {
          const value = JSON.parse(raw) as { rpcUrl?: string; block?: { selection?: string } };
          delete value.rpcUrl;
          if (value.block) delete value.block.selection;
          return JSON.stringify(value);
        };
        if (measurementOnly(existing) !== measurementOnly(serialized)) {
          throw new Error(`Evidence file ${outPath} already exists with a different measurement — refusing to overwrite`);
        }
        console.log(`[measure-cdp] ${parsed.assetId}: identical measurement already recorded at ${outPath}`);
        return;
      }
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, serialized);
      const priceLine =
        parsed.family === "liquity-v1"
          ? `price=${parsed.derived.priceUsd} (chainlink delta ${parsed.derived.chainlink.deltaPct}%, lastGoodPrice delta ${parsed.derived.lastGoodPrice.deltaPct}%)`
          : `branches=${parsed.derived.branches.length} branchCappedCapacity=${parsed.derived.branchCappedLiquidationCapacityRatio} priceCrossCheck=${parsed.derived.priceCrossCheck.mode}`;
      console.log(
        `[measure-cdp] ${parsed.assetId}: block ${parsed.block.number} (${parsed.block.selection}) via ${rpcUrl}\n` +
          `  collateralizationRatio=${parsed.metrics.collateralizationRatio} liquidationCapacityRatio=${parsed.metrics.liquidationCapacityRatio}\n` +
          `  ${priceLine}\n` +
          `  checks=${parsed.checks.length} pass -> ${outPath}`,
      );
      return;
    } catch (error) {
      lastError = error;
      console.warn(`[measure-cdp] ${assetId}: ${rpcUrl} failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`All RPC endpoints failed for ${assetId}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

void runCliEntrypoint(
  async () => {
    const options = parseOptions(process.argv.slice(2));
    if (!options) return;
    const assetIds = options.assets.length > 0 ? options.assets : CDP_MEASUREMENT_TARGETS.map((target) => target.assetId);
    for (const assetId of assetIds) {
      await measureTarget(options, assetId);
    }
  },
  { label: "measure-cdp-mechanism-metrics", usage: USAGE },
);
