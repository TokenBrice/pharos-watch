#!/usr/bin/env tsx

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { ContractDeployment, StablecoinMeta } from "@shared/types";
import { runAsMain, toPositiveInt } from "../lib/coverage-audit-cli";

const DEFAULT_OUTPUT_DIR = "agents/mint-authority-candidates";
const DEFAULT_LIMIT = 25;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface MintAuthorityProviderCapabilities {
  directRpc: {
    available: boolean;
    env: string[];
  };
  etherscanV2: {
    available: boolean;
    env: string[];
  };
  sourcify: {
    available: boolean;
    mode: "public-api";
  };
  safeTransactionService: {
    available: boolean;
    mode: "public-api";
  };
  blockscout: {
    available: boolean;
    reason: string;
  };
}

export interface MintAuthorityCandidateContract {
  chain: string;
  address: string;
  decimals: number;
  evmAddress: boolean;
  scannerStatus: "queued-not-scanned" | "unsupported-address";
  notes: string[];
}

export interface MintAuthorityCandidate {
  coinId: string;
  generatedAt: string;
  contractsScanned: MintAuthorityCandidateContract[];
  providerCapabilities: MintAuthorityProviderCapabilities;
  deploymentBlocks: Record<string, never>;
  finalizedHeads: Record<string, never>;
  scannedRanges: never[];
  eventScanComplete: false;
  roleAdminGraph: Record<string, never>;
  candidateMintAuthority: {
    mintPath: "unknown";
    authorityPosture: "unknown";
    confidence: "unknown";
    summary: string;
    controls: never[];
  };
  evidence: never[];
  warnings: string[];
  manualReviewRequired: string[];
}

export interface AuditMintAuthorityOptions {
  coinIds: string[];
  limit: number;
  all: boolean;
  outputDir: string;
  generatedAt: string;
  json: boolean;
}

function usage(): string {
  return [
    "Usage: tsx scripts/maintenance/audit-mint-authority.ts [options]",
    "",
    "Options:",
    "  --coin <id>           Emit a candidate for one coin. Repeat for multiple coins.",
    `  --limit <n>           Emit first n active coins when --coin/--all is omitted (default ${DEFAULT_LIMIT})`,
    "  --all                 Emit candidates for every active coin",
    `  --out-dir <path>      Candidate output directory (default ${DEFAULT_OUTPUT_DIR})`,
    "  --generated-at <iso>  Override generatedAt timestamp",
    "  --json                Print one JSON array to stdout instead of writing files",
    "  --help, -h            Show this help text",
  ].join("\n");
}

export function parseArgs(argv: string[], now = new Date()): AuditMintAuthorityOptions {
  const options: AuditMintAuthorityOptions = {
    coinIds: [],
    limit: DEFAULT_LIMIT,
    all: false,
    outputDir: DEFAULT_OUTPUT_DIR,
    generatedAt: now.toISOString(),
    json: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--coin") {
      const coinId = argv[++index];
      if (!coinId) throw new Error("--coin requires a stablecoin ID");
      options.coinIds.push(coinId);
    } else if (arg === "--limit") {
      options.limit = toPositiveInt(argv[++index] ?? "", "--limit");
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--out-dir") {
      const outputDir = argv[++index];
      if (!outputDir) throw new Error("--out-dir requires a path");
      options.outputDir = outputDir;
    } else if (arg === "--generated-at") {
      const generatedAt = argv[++index];
      if (!generatedAt) throw new Error("--generated-at requires an ISO timestamp");
      options.generatedAt = generatedAt;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.all && options.coinIds.length > 0) {
    throw new Error("Choose either --all or one or more --coin values, not both.");
  }

  return options;
}

type Environment = Readonly<Record<string, string | undefined>>;

function hasAnyEnv(env: Environment, names: readonly string[]): string[] {
  return names.filter((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

export function buildProviderCapabilities(env: Environment = process.env): MintAuthorityProviderCapabilities {
  const rpcEnv = hasAnyEnv(env, ["ALCHEMY_API_KEY", "DRPC_API_KEY"]);
  const etherscanEnv = hasAnyEnv(env, ["ETHERSCAN_API_KEY"]);

  return {
    directRpc: {
      available: rpcEnv.length > 0,
      env: rpcEnv,
    },
    etherscanV2: {
      available: etherscanEnv.length > 0,
      env: etherscanEnv,
    },
    sourcify: {
      available: true,
      mode: "public-api",
    },
    safeTransactionService: {
      available: true,
      mode: "public-api",
    },
    blockscout: {
      available: false,
      reason: "POC has no explicit per-chain Blockscout endpoint map.",
    },
  };
}

function isLikelyEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function contractCandidate(contract: ContractDeployment): MintAuthorityCandidateContract {
  const address = contract.address.trim();
  const evmAddress = isLikelyEvmAddress(address);
  return {
    chain: contract.chain,
    address,
    decimals: contract.decimals,
    evmAddress,
    scannerStatus: evmAddress ? "queued-not-scanned" : "unsupported-address",
    notes: evmAddress
      ? ["POC skeleton queued this contract for future EVM authority adapters."]
      : ["POC skeleton only recognizes EVM address format."],
  };
}

export function buildMintAuthorityCandidate(
  coin: Pick<StablecoinMeta, "id" | "symbol" | "contracts">,
  options: {
    generatedAt: string;
    providerCapabilities?: MintAuthorityProviderCapabilities;
  },
): MintAuthorityCandidate {
  const contractsScanned = (coin.contracts ?? []).map(contractCandidate);
  const evmContractCount = contractsScanned.filter((contract) => contract.evmAddress).length;
  const warnings: string[] = [];
  const manualReviewRequired = ["Scanner POC is discovery-only; curate sources before adding mintAuthority metadata."];

  if (contractsScanned.length === 0) {
    warnings.push("No contract metadata is available in the local stablecoin registry.");
    manualReviewRequired.push("Find official token/control addresses before review.");
  } else if (evmContractCount === 0) {
    warnings.push("No EVM-format contract address was found; non-EVM authority adapters are not implemented.");
    manualReviewRequired.push("Use chain-specific sources for non-EVM mint authority review.");
  } else {
    warnings.push("Network scans are not implemented in this POC; all EVM contracts remain unverified candidates.");
    manualReviewRequired.push("Run source/proxy/role/Safe adapters before treating any candidate as evidence.");
  }

  return {
    coinId: coin.id,
    generatedAt: options.generatedAt,
    contractsScanned,
    providerCapabilities: options.providerCapabilities ?? buildProviderCapabilities(),
    deploymentBlocks: {},
    finalizedHeads: {},
    scannedRanges: [],
    eventScanComplete: false,
    roleAdminGraph: {},
    candidateMintAuthority: {
      mintPath: "unknown",
      authorityPosture: "unknown",
      confidence: "unknown",
      summary: `${coin.symbol} mint authority is not reviewed by this local scanner POC.`,
      controls: [],
    },
    evidence: [],
    warnings,
    manualReviewRequired,
  };
}

function resolveSelectedCoins(options: AuditMintAuthorityOptions): StablecoinMeta[] {
  if (options.coinIds.length > 0) {
    return options.coinIds.map((id) => {
      const coin = ACTIVE_META_BY_ID.get(id);
      if (!coin) throw new Error(`Unknown active stablecoin ID: ${id}`);
      return coin;
    });
  }

  return options.all ? [...ACTIVE_STABLECOINS] : ACTIVE_STABLECOINS.slice(0, options.limit);
}

function assertSafeOutputDir(cwd: string, outputDir: string): string {
  const target = resolve(cwd, outputDir);
  const stablecoinDataRoot = resolve(REPO_ROOT, "shared/data/stablecoins");
  const pathFromStablecoinDataRoot = relative(stablecoinDataRoot, target);
  const isStablecoinDataPath =
    pathFromStablecoinDataRoot === "" ||
    (!!pathFromStablecoinDataRoot &&
      !pathFromStablecoinDataRoot.startsWith("..") &&
      !isAbsolute(pathFromStablecoinDataRoot));

  if (isStablecoinDataPath) {
    throw new Error("audit-mint-authority writes candidate artifacts only; use agents/mint-authority-candidates.");
  }
  return target;
}

function writeCandidate(outputDir: string, candidate: MintAuthorityCandidate): void {
  mkdirSync(outputDir, { recursive: true });
  const target = resolve(outputDir, `${candidate.coinId}.json`);
  writeFileSync(target, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
}

export async function runCli(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env: Environment = process.env,
  stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): Promise<number> {
  const options = parseArgs(argv);
  const coins = resolveSelectedCoins(options);
  const providerCapabilities = buildProviderCapabilities(env);
  const candidates = coins.map((coin) =>
    buildMintAuthorityCandidate(coin, {
      generatedAt: options.generatedAt,
      providerCapabilities,
    }),
  );

  if (options.json) {
    stdout.write(`${JSON.stringify(candidates, null, 2)}\n`);
    return 0;
  }

  const outputDir = assertSafeOutputDir(cwd, options.outputDir);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  for (const candidate of candidates) {
    writeCandidate(outputDir, candidate);
  }

  stdout.write(`wrote ${candidates.length} mint authority candidate file(s) to ${outputDir}\n`);
  return 0;
}

runAsMain(import.meta.url, runCli);
