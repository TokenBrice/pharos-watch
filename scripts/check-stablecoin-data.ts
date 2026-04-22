import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CanonicalOrderAssetSchema } from "../shared/lib/stablecoins/schema";
import { validateVariantRelationships } from "../shared/lib/stablecoins/validate-variants";
import { CHAIN_META } from "../shared/lib/chains";
import type { StablecoinMeta } from "../shared/types";
import {
  CANONICAL_ORDER_ASSET_FILE,
  findCanonicalOrderIssues,
  findDuplicateStablecoinIds,
  GENERATED_PER_COIN_ASSET_FILE,
  LEGACY_STABLECOIN_ASSET_FILES,
  loadGeneratedPerCoinCoins,
  loadLegacyStablecoinEntries,
  loadPerCoinStablecoinEntries,
  PER_COIN_SOURCE_DIR,
  STABLECOIN_DATA_DIR,
  syncGeneratedPerCoinAsset,
  type StablecoinSourceEntry,
} from "./lib/stablecoin-catalog-sources";

const RESERVE_TOTAL_TOLERANCE = 0.5;
const RESERVE_TOTAL_ALLOWLIST = new Set<string>();

let errorCount = 0;

function reportError(message: string): void {
  process.stderr.write(`${message}\n`);
  errorCount++;
}

function readCanonicalOrder(): string[] {
  const path = join(STABLECOIN_DATA_DIR, CANONICAL_ORDER_ASSET_FILE);
  try {
    const result = CanonicalOrderAssetSchema.safeParse(
      // Repo-owned validation only reads the checked-in canonical-order asset.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
    if (result.success) {
      process.stdout.write(`${path}: ${result.data.length} entries OK\n`);
      return result.data;
    }

    const issues = result.error.issues
      .slice(0, 8)
      .map((issue) => {
        const issuePath = issue.path.length > 0 ? `[${issue.path.join(".")}]` : "";
        return `${path}${issuePath}: ${issue.message}`;
      });
    for (const issue of issues) {
      reportError(issue);
    }
    return [];
  } catch (error) {
    reportError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function hasSupportedOnchainSupplyContract(coin: StablecoinMeta): boolean {
  return coin.contracts?.some((contract) => {
    if (contract.chain === "solana") return true;
    return CHAIN_META[contract.chain]?.type === "evm" && contract.address.startsWith("0x");
  }) ?? false;
}

function getRuntimeAdmissionIssue(coin: StablecoinMeta): string | null {
  if (coin.status === "pre-launch") return null;
  if (coin.llamaId) return null;

  const isCommodity = coin.flags.pegCurrency === "GOLD" || coin.flags.pegCurrency === "SILVER";
  if (isCommodity && coin.geckoId) return null;

  if (coin.detailProvider === "coingecko") {
    if (coin.geckoId || hasSupportedOnchainSupplyContract(coin)) return null;

    return (
      "active detailProvider=coingecko asset needs geckoId or a supported on-chain supply contract " +
      "so sync-stablecoins can admit it into /api/stablecoins"
    );
  }

  if (coin.detailProvider === "defillama") {
    return "active detailProvider=defillama asset needs llamaId for /api/stablecoins cache admission";
  }

  if (coin.detailProvider === "commodity") {
    return "active commodity detailProvider asset needs geckoId for /api/stablecoins cache admission";
  }

  return (
    "active asset lacks a /api/stablecoins cache admission path; add llamaId, or mark detailProvider=coingecko " +
    "with geckoId or a supported on-chain supply contract"
  );
}

function getStatusPartitionIssue(entry: StablecoinSourceEntry): string | null {
  if (entry.sourceKind !== "legacy") {
    return null;
  }

  if (entry.legacyShard === "pre-launch.json") {
    return entry.coin.status === "pre-launch"
      ? null
      : "pre-launch.json may only contain assets with status=pre-launch";
  }

  return entry.coin.status === "pre-launch"
    ? "pre-launch assets belong in shared/data/stablecoins/pre-launch.json"
    : null;
}

function getReserveTotalIssue(coin: StablecoinMeta): string | null {
  if (!coin.reserves || coin.reserves.length === 0) return null;

  const total = coin.reserves.reduce((sum, reserve) => sum + reserve.pct, 0);
  if (total <= 0) {
    return "reserve pct total must be greater than 0";
  }

  if (
    !RESERVE_TOTAL_ALLOWLIST.has(coin.id)
    && Math.abs(total - 100) > RESERVE_TOTAL_TOLERANCE
  ) {
    return `reserve pct total ${total} is outside 100 +/- ${RESERVE_TOTAL_TOLERANCE}`;
  }

  return null;
}

function getDependencyTotalIssue(coin: StablecoinMeta): string | null {
  if (!coin.dependencies || coin.dependencies.length === 0) return null;

  const total = coin.dependencies.reduce((sum, dependency) => sum + dependency.weight, 0);
  return total > 0 ? null : "dependency weight total must be greater than 0";
}

let canonicalOrder: string[] = [];
let legacyEntries: StablecoinSourceEntry[] = [];
let perCoinEntries: StablecoinSourceEntry[] = [];
let generatedPerCoinCoins: StablecoinMeta[] = [];

canonicalOrder = readCanonicalOrder();

try {
  legacyEntries = loadLegacyStablecoinEntries();
  for (const file of LEGACY_STABLECOIN_ASSET_FILES) {
    const relativePath = `${STABLECOIN_DATA_DIR}/${file}`;
    const count = legacyEntries.filter((entry) => entry.file === relativePath).length;
    process.stdout.write(`${relativePath}: ${count} entries OK\n`);
  }
} catch (error) {
  reportError(error instanceof Error ? error.message : String(error));
}

try {
  perCoinEntries = loadPerCoinStablecoinEntries();
  process.stdout.write(`${PER_COIN_SOURCE_DIR}: ${perCoinEntries.length} entries OK\n`);
} catch (error) {
  reportError(error instanceof Error ? error.message : String(error));
}

try {
  generatedPerCoinCoins = loadGeneratedPerCoinCoins();
  process.stdout.write(`${GENERATED_PER_COIN_ASSET_FILE}: ${generatedPerCoinCoins.length} entries OK\n`);
} catch (error) {
  reportError(error instanceof Error ? error.message : String(error));
}

if (errorCount === 0) {
  try {
    syncGeneratedPerCoinAsset({ check: true });
    process.stdout.write(`${GENERATED_PER_COIN_ASSET_FILE}: generated aggregate is current\n`);
  } catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
  }
}

if (errorCount === 0) {
  const allEntries = [...legacyEntries, ...perCoinEntries];

  for (const issue of findDuplicateStablecoinIds(allEntries)) {
    reportError(
      `${STABLECOIN_DATA_DIR}: duplicate stablecoin id "${issue.id}" found in ${issue.entries.map((entry) => entry.file).join(", ")}`,
    );
  }

  const canonicalIssues = findCanonicalOrderIssues(canonicalOrder, allEntries);
  for (const id of canonicalIssues.duplicateIds) {
    reportError(`${STABLECOIN_DATA_DIR}/${CANONICAL_ORDER_ASSET_FILE}: duplicate stablecoin ID "${id}"`);
  }
  for (const id of canonicalIssues.unknownIds) {
    reportError(`${STABLECOIN_DATA_DIR}/${CANONICAL_ORDER_ASSET_FILE}: unknown stablecoin ID "${id}"`);
  }
  if (canonicalIssues.missingIds.length > 0) {
    reportError(
      `${STABLECOIN_DATA_DIR}/${CANONICAL_ORDER_ASSET_FILE}: missing tracked stablecoin IDs ${canonicalIssues.missingIds.join(", ")}`,
    );
  }

  for (const entry of allEntries) {
    const partitionIssue = getStatusPartitionIssue(entry);
    if (partitionIssue) {
      reportError(`${entry.file} (${entry.coin.id}): ${partitionIssue}`);
    }

    const reserveTotalIssue = getReserveTotalIssue(entry.coin);
    if (reserveTotalIssue) {
      reportError(`${entry.file} (${entry.coin.id}): ${reserveTotalIssue}`);
    }

    const dependencyTotalIssue = getDependencyTotalIssue(entry.coin);
    if (dependencyTotalIssue) {
      reportError(`${entry.file} (${entry.coin.id}): ${dependencyTotalIssue}`);
    }

    const runtimeAdmissionIssue = getRuntimeAdmissionIssue(entry.coin);
    if (runtimeAdmissionIssue) {
      reportError(`${entry.file} (${entry.coin.id}): ${runtimeAdmissionIssue}`);
    }
  }

  for (const error of validateVariantRelationships(allEntries.map((entry) => entry.coin))) {
    reportError(`${STABLECOIN_DATA_DIR}: ${error}`);
  }
}

if (errorCount > 0) {
  process.stderr.write(`\n${errorCount} error(s) found in stablecoin data files.\n`);
  process.exit(1);
}
process.stdout.write("Stablecoin data validation: OK\n");
