import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parseCliInteger, parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { fetchBlockByNumber, pinBlock } from "../lib/mechanism-measurement/core";
import { JournaledShockCaller, ReplayShockCaller } from "../lib/mechanism-measurement/shock-journal";
import { measureConfiguredShockCoverageTarget } from "../lib/mechanism-measurement/shock-measure";
import { ShockCoverageEvidenceV1Schema, type ShockCoverageEvidenceV1 } from "../lib/mechanism-measurement/shock-schema";
import {
  assessShockCoverageApplicability,
  getShockCoverageTarget,
  SHOCK_COVERAGE_TARGETS,
  type ShockCoverageTarget,
} from "../lib/mechanism-measurement/shock-targets";

const DEFAULT_OUT_DIR = "shared/data/safety-score-v9/mechanism-measurements";

const USAGE = `Usage: npx tsx scripts/maintenance/measure-cdp-shock-coverage.ts [options]

Captures complete Liquity V1/V2 position snapshots at one pinned block, runs
the journaled Option D liquidation simulator, and writes append-only evidence.

Options:
  --asset <id>                 Target asset id (repeatable; default: all configured targets)
  --rpc <url>                  Override the RPC endpoint list with a single endpoint
  --block <number>             Measure an explicit historical block instead of the finalized head
  --out-dir <path>             Evidence root (default: ${DEFAULT_OUT_DIR})
  --replay <path>              Offline byte-replay an evidence artifact (repeatable; exclusive)
  --check-applicability <id>   Print the simulator/fallback decision as JSON (repeatable; exclusive)
  -h, --help                   Show this help`;

interface CliOptions {
  assets: string[];
  rpc: string | null;
  block: number | null;
  outDir: string;
  replayPaths: string[];
  applicabilityAssets: string[];
}

function parseOptions(argv: string[]): CliOptions | null {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      asset: { type: "string", multiple: true },
      rpc: { type: "string" },
      block: { type: "string" },
      "out-dir": { type: "string" },
      replay: { type: "string", multiple: true },
      "check-applicability": { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return null;

  const assets = Array.isArray(values.asset) ? values.asset.map(String) : [];
  const replayPaths = Array.isArray(values.replay) ? values.replay.map(String) : [];
  const applicabilityAssets = Array.isArray(values["check-applicability"])
    ? values["check-applicability"].map(String)
    : [];
  const liveOptionPresent =
    assets.length > 0 || values.rpc != null || values.block != null || values["out-dir"] != null;
  if (replayPaths.length > 0 && (liveOptionPresent || applicabilityAssets.length > 0)) {
    throw new Error("--replay is exclusive with live and applicability options");
  }
  if (applicabilityAssets.length > 0 && liveOptionPresent) {
    throw new Error("--check-applicability is exclusive with live measurement options");
  }

  return {
    assets,
    rpc: typeof values.rpc === "string" ? values.rpc : null,
    block: values.block == null ? null : parseCliInteger(values.block, { name: "--block", min: 1 }),
    outDir: typeof values["out-dir"] === "string" ? values["out-dir"] : DEFAULT_OUT_DIR,
    replayPaths,
    applicabilityAssets,
  };
}

function measurementOnly(value: unknown): string {
  const cloned = structuredClone(value) as { rpcUrl?: string; block?: { selection?: string } };
  delete cloned.rpcUrl;
  if (cloned.block) delete cloned.block.selection;
  return JSON.stringify(cloned);
}

function replayTargetFromEvidence(recorded: ShockCoverageEvidenceV1): ShockCoverageTarget {
  if (recorded.family === "liquity-v1-shock-v1") {
    const branch = recorded.branches[0]!;
    return {
      assetId: recorded.assetId,
      family: recorded.family,
      chain: recorded.chain,
      rpcs: [recorded.rpcUrl],
      maxPositionsPerBranch: 5_000,
      contracts: {
        token: branch.contracts.token,
        troveManager: branch.contracts.troveManager,
        stabilityPool: branch.contracts.stabilityPool,
        priceFeed: branch.contracts.priceFeed,
        borrowerOperations: branch.contracts.borrowerOperations,
        gasPool: branch.contracts.gasPool,
        collSurplusPool: branch.contracts.collSurplusPool,
      },
      sourcePin: recorded.sourcePin,
      sources: recorded.sources,
    };
  }

  const codeAddress = (name: string): string => {
    const pin = recorded.codePins.find((candidate) => candidate.name === name);
    if (!pin) throw new Error(`Recorded ${recorded.assetId} evidence is missing code pin ${name}`);
    return pin.address;
  };
  const replayOracleGraph = (branch: (typeof recorded.branches)[number]) => {
    if (recorded.assetId !== "bd-basedollar" || recorded.family !== "liquity-v2-shock-v1") return undefined;
    const primaryImplementationAddress = branch.contracts.ethUsdOracleImplementation;
    if (branch.label === "WETH") return { primaryImplementationAddress };
    if (branch.label === "wstETH") {
      return {
        primaryImplementationAddress,
        secondary: {
          signature: "stEthUsdOracle()",
          selector: "0xd69e820d",
          implementationAddress: branch.contracts.secondaryOracleImplementation!,
        },
        rateProvider: {
          signature: "rateProviderAddress()",
          selector: "0xe5aa1c40",
          expectedAddress: branch.contracts.rateProvider!,
        },
      };
    }
    if (branch.label === "rETH") {
      return {
        primaryImplementationAddress,
        secondary: {
          signature: "rEthEthOracle()",
          selector: "0x03f04756",
          implementationAddress: branch.contracts.secondaryOracleImplementation!,
        },
        rateProvider: {
          signature: "rateProviderAddress()",
          selector: "0xe5aa1c40",
          expectedAddress: branch.contracts.rateProvider!,
        },
      };
    }
    if (branch.label === "cbBTC") {
      return {
        primaryImplementationAddress,
        secondary: {
          signature: "btcUsdOracle()",
          selector: "0xca1ca21c",
          implementationAddress: branch.contracts.secondaryOracleImplementation!,
        },
      };
    }
    if (branch.label === "cbETH") {
      return {
        primaryImplementationAddress,
        secondary: {
          signature: "cbEthEthOracle()",
          selector: "0x4403b69b",
          implementationAddress: branch.contracts.secondaryOracleImplementation!,
        },
      };
    }
    throw new Error(`Unsupported Base Dollar replay branch ${branch.label}`);
  };
  return {
    assetId: recorded.assetId,
    family: recorded.family,
    chain: recorded.chain,
    rpcs: [recorded.rpcUrl],
    maxPositionsPerBranch: 5_000,
    maxBranches: 16,
    contracts: {
      token: codeAddress("bold-token"),
      collateralRegistry: codeAddress("collateral-registry"),
    },
    spDeposits: { signature: "getTotalBoldDeposits()", selector: "0xf71c6940" },
    branches: recorded.branches.map((branch) => ({
      collateralSymbol: branch.label,
      addressesRegistry: branch.contracts.addressesRegistry,
      oracleGraph: replayOracleGraph(branch),
    })),
    sourcePin: recorded.sourcePin,
    sources: recorded.sources,
  };
}

function assertExistingMeasurement(outPath: string, evidence: ShockCoverageEvidenceV1): void {
  const existing = ShockCoverageEvidenceV1Schema.parse(JSON.parse(readFileSync(outPath, "utf8")));
  if (measurementOnly(existing) !== measurementOnly(evidence)) {
    throw new Error(`Evidence ${outPath} exists with a different measurement; refusing to overwrite`);
  }
}

async function replayEvidence(path: string): Promise<void> {
  const absolutePath = resolve(path);
  const recorded = ShockCoverageEvidenceV1Schema.parse(JSON.parse(readFileSync(absolutePath, "utf8")));
  const target = replayTargetFromEvidence(recorded);

  const caller = new ReplayShockCaller(recorded.calls, recorded.codePins);
  const recomputed = ShockCoverageEvidenceV1Schema.parse(
    await measureConfiguredShockCoverageTarget(caller, target, recorded.block, recorded.rpcUrl),
  );
  caller.assertExhausted();
  if (JSON.stringify(recomputed) !== JSON.stringify(recorded)) {
    throw new Error(`Offline replay diverged from recorded artifact ${absolutePath}`);
  }
  console.log(
    `[shock-coverage] ${recorded.assetId}: byte-identical offline replay passed ` +
      `(${recorded.calls.length} calls, ${recorded.codePins.length} code pins) -> ${absolutePath}`,
  );
}

async function measureTarget(options: CliOptions, assetId: string): Promise<void> {
  const target = getShockCoverageTarget(assetId);
  if (!target) {
    throw new Error(
      `No shock target configured for ${assetId} (known: ${SHOCK_COVERAGE_TARGETS.map((entry) => entry.assetId).join(", ")})`,
    );
  }

  const rpcs = options.rpc ? [options.rpc] : target.rpcs;
  let lastError: unknown = null;
  for (const rpcUrl of rpcs) {
    try {
      const block = options.block == null ? await pinBlock(rpcUrl) : await fetchBlockByNumber(rpcUrl, options.block);
      const caller = new JournaledShockCaller(rpcUrl, { blockHash: block.hash, requireCanonical: true });
      const evidence = ShockCoverageEvidenceV1Schema.parse(
        await measureConfiguredShockCoverageTarget(caller, target, block, rpcUrl),
      );
      const date = evidence.block.timestampIso.slice(0, 10);
      const outPath = resolve(
        join(options.outDir, evidence.assetId, `${date}-block-${evidence.block.number}-shock-coverage.json`),
      );
      const serialized = `${JSON.stringify(evidence, null, 2)}\n`;

      mkdirSync(dirname(outPath), { recursive: true });
      try {
        writeFileSync(outPath, serialized, { flag: "wx" });
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
        assertExistingMeasurement(outPath, evidence);
        console.log(`[shock-coverage] ${assetId}: identical measurement already recorded at ${outPath}`);
        return;
      }
      console.log(
        `[shock-coverage] ${assetId}: block ${evidence.block.number} (${evidence.block.selection}) via ${rpcUrl}\n` +
          `  coverage50=${evidence.measuredFacts.stressLiquidationCoverageRatio} ` +
          `Q50=${evidence.measuredFacts.stressLiquidatableDebt} ` +
          `O50=${evidence.measuredFacts.stressPoolOffsetDebt}\n` +
          `  calls=${evidence.calls.length} codePins=${evidence.codePins.length} checks=${evidence.checks.length} -> ${outPath}`,
      );
      return;
    } catch (error) {
      lastError = error;
      console.warn(
        `[shock-coverage] ${assetId}: ${rpcUrl} failed - ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `All RPC endpoints failed for ${assetId}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

void runCliEntrypoint(
  async () => {
    const options = parseOptions(process.argv.slice(2));
    if (!options) return;
    if (options.replayPaths.length > 0) {
      for (const path of options.replayPaths) await replayEvidence(path);
      return;
    }
    if (options.applicabilityAssets.length > 0) {
      for (const assetId of options.applicabilityAssets) {
        console.log(JSON.stringify(assessShockCoverageApplicability(assetId)));
      }
      return;
    }

    const assetIds =
      options.assets.length > 0 ? options.assets : SHOCK_COVERAGE_TARGETS.map((target) => target.assetId);
    for (const assetId of assetIds) await measureTarget(options, assetId);
  },
  { label: "measure-cdp-shock-coverage", usage: USAGE },
);
