import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { CHAIN_META } from "@shared/lib/chains";
import { COMMODITY_PEG_CURRENCIES, isCommodityPeg } from "@shared/lib/filter-tags";
import { hasRuntimeOnchainSupplyPath } from "@shared/lib/onchain-supply-probe";
import { CanonicalOrderAssetSchema } from "@shared/lib/stablecoins/schema";
import { type ListingDecisionRegistry } from "@shared/lib/stablecoins/listing-governance";
import { isActiveStablecoinMeta, isReadableStablecoinMeta } from "@shared/lib/stablecoins/status";
import { validateMintBridgeOwnership } from "@shared/lib/stablecoins/mint-bridge-ownership";
import { validateVariantRelationships } from "@shared/lib/stablecoins/validate-variants";
import { findCollateralProseReserveDriftFindings } from "@shared/lib/stablecoins/collateral-prose-reserve-drift";
import { classifyPegClass, normalizePegTypeFromCurrency } from "@shared/lib/peg-price-bounds";
import type { DeadStablecoin, StablecoinMeta } from "@shared/types";
import listingDecisionsAsset from "@shared/data/stablecoins/listing-decisions.json";
import { RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT, validateReserveCompositionTotal } from "@shared/types/reserves";
import { findBlacklistabilityReviewIssues } from "../lib/blacklistability-review";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { getTrackedAlgorithmicBackingIssue } from "../lib/stablecoin-data-gate-issues";
import {
  CANONICAL_ORDER_ASSET_FILE,
  findCanonicalOrderIssues,
  findDuplicateStablecoinIds,
  findRecreatedRetiredStablecoinAssetFiles,
  formatRecreatedRetiredAssetFileIssue,
  GENERATED_PER_COIN_ASSET_FILE,
  loadGeneratedPerCoinCoins,
  loadPerCoinStablecoinEntries,
  STABLECOIN_DATA_DIR,
  syncGeneratedPerCoinAsset,
  type StablecoinSourceEntry,
} from "../lib/stablecoin-catalog-sources";

const RESERVE_TOTAL_ALLOWLIST = new Set<string>();
const SAFETY_SCORE_V9_PUBLIC_BACKING_COMPONENT_LABEL_MAX_LENGTH = 160;
// Keep synchronized with DEDICATED_SINGLE_TOKEN_GOLD_PROTOCOL_SLUGS in
// worker/src/cron/sync-stablecoins/supplemental-assets/gold.ts. This CI script
// mirrors the small runtime allowlist instead of importing the Worker fetch graph.
const DEDICATED_SINGLE_TOKEN_GOLD_PROTOCOL_SLUGS = new Set([
  "tether-gold",
  "paxos-gold",
]);
const ACTIVE_DEAD_LLAMA_ID_OVERLAP_ALLOWLIST = new Set([
  // Kava USDX remains a live tracked feed while the cemetery keeps the 2022
  // UST-collateral depeg incident as a separate historical row.
  "42::usdx-kava::usdx-kava-usdx-2022-06",
  // Hubble USDH remains readable for active/frozen surfaces while the cemetery
  // keeps the 2026 wind-down incident distinct from Native Markets/Hermetica USDH.
  "65::usdh-hubble::usdh-hubble-2026-05",
]);

const LISTING_CLASS_VALUES = [
  "core-stablecoin",
  "cash-equivalent",
  "stablecoin-variant",
  "stable-value-investment",
  "excluded",
] as const;

const ListingDecisionRegistrySchema: z.ZodType<ListingDecisionRegistry> = z
  .object({
    schemaVersion: z.literal(1),
    policyVersion: z.string().trim().min(1),
    listingClassById: z.record(z.string().trim().min(1), z.enum(LISTING_CLASS_VALUES)),
  })
  .strict();

const LOGOS_FILE = "data/logos.json";

let errorCount = 0;
let warningCount = 0;

function reportError(message: string): void {
  process.stderr.write(`${message}\n`);
  errorCount++;
}

/**
 * Advisory lane. Curation-quality findings that a human should read but that
 * must never block a release — the prose surfaces they cover carry legitimate
 * exceptions the detector cannot distinguish from defects.
 */
function reportWarning(message: string): void {
  process.stdout.write(`warning: ${message}\n`);
  warningCount++;
}

function readCanonicalOrder(): string[] {
  const path = join(STABLECOIN_DATA_DIR, CANONICAL_ORDER_ASSET_FILE);
  try {
    const result = CanonicalOrderAssetSchema.safeParse(
      // Repo-owned validation only reads the checked-in canonical-order asset.
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
    if (result.success) {
      return result.data;
    }

    const issues = result.error.issues.slice(0, 8).map((issue) => {
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

function getRuntimeAdmissionIssue(coin: StablecoinMeta): string | null {
  if (!isActiveStablecoinMeta(coin)) return null;
  if (coin.llamaId) return null;

  const isCommodity = isCommodityPeg(coin.flags.pegCurrency);
  if (isCommodity && coin.geckoId) return null;

  if (coin.detailProvider === "coingecko") {
    if (coin.geckoId || hasRuntimeOnchainSupplyPath(coin)) return null;

    return (
      "active detailProvider=coingecko asset needs geckoId, Zephyr Scanner support, a curated aggregate supply path, " +
      "or one unambiguous supported on-chain supply contract " +
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
    "with geckoId or a runtime-supported on-chain supply path"
  );
}

function getCommodityOuncesIssue(coin: StablecoinMeta): string | null {
  if (!isActiveStablecoinMeta(coin)) return null;
  if (!isCommodityPeg(coin.flags.pegCurrency)) return null;
  if (coin.commodityOunces != null && coin.commodityOunces > 0) return null;

  return (
    "GOLD/SILVER-pegged asset must declare commodityOunces (troy ounces per token); " +
    "without it peg-rates silently treats the price as per-troy-ounce, fabricating peg deviation " +
    "for non-1oz denominations and contaminating the commodity peer median"
  );
}

export function getCommodityProtocolSlugIssue(coin: StablecoinMeta): string | null {
  if (!isCommodityPeg(coin.flags.pegCurrency) || !coin.protocolSlug) return null;
  if (DEDICATED_SINGLE_TOKEN_GOLD_PROTOCOL_SLUGS.has(coin.protocolSlug)) return null;

  return (
    `${coin.flags.pegCurrency}-pegged commodity asset has non-dedicated protocolSlug "${coin.protocolSlug}" ` +
    "(allowlisted for protocol-mcap supply: tether-gold, paxos-gold); the gold supply lane ignores it, " +
    "but confirm the slug is intentional for TVL history / selector concentration grouping"
  );
}

function getPegRuntimeSupportIssue(coin: StablecoinMeta): string | null {
  if (!isActiveStablecoinMeta(coin)) return null;

  const pegCurrency = coin.flags.pegCurrency;
  const pegType = normalizePegTypeFromCurrency(pegCurrency);
  const pegClass = classifyPegClass(pegCurrency, pegType, Boolean(coin.flags.navToken));
  if (pegClass !== "unknown") return null;

  return (
    `pegCurrency ${pegCurrency} classifies as "unknown" peg class at runtime: price validation accepts any ` +
    "price under $100k with no peg band, no FX reference, and no depeg coverage. Before activating a coin " +
    "on this peg, add it to classifyPegClass + FX_RATE_BOUNDS + PEG_HARDCODED_PRICE_BOUNDS and wire its FX rate " +
    "(see the GELT/GEL promotion checklist pattern)"
  );
}

function getReserveTotalIssue(coin: StablecoinMeta): string | null {
  if (!coin.reserves || coin.reserves.length === 0) return null;

  const total = coin.reserves.reduce((sum, reserve) => sum + reserve.pct, 0);
  if (total <= 0) {
    return "reserve pct total must be greater than 0";
  }

  if (!RESERVE_TOTAL_ALLOWLIST.has(coin.id) && !validateReserveCompositionTotal(coin.reserves, "full")) {
    return `reserve pct total ${total} is outside 100 +/- ${RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT}`;
  }

  return null;
}

export function getReservePublicLabelIssues(coin: StablecoinMeta): string[] {
  const issues: string[] = [];

  (coin.reserves ?? []).forEach((reserve, index) => {
    const publicLabelLength = reserve.name.trim().length;
    if (publicLabelLength <= SAFETY_SCORE_V9_PUBLIC_BACKING_COMPONENT_LABEL_MAX_LENGTH) return;
    issues.push(
      `reserves[${index}] "${reserve.name}" is ${publicLabelLength} characters; ` +
        `Safety Score V9 public backing component labels are capped at ` +
        `${SAFETY_SCORE_V9_PUBLIC_BACKING_COMPONENT_LABEL_MAX_LENGTH} characters`,
    );
  });

  return issues;
}

// D2 honesty guard (owner ruling 2026-07-23): the privileged commodity-allocated
// reserve class (quality 90, maturity N/A) is admissible only when the coin's peg
// IS the vaulted metal — USD-pegged metal reserves must stay on their risk class.

export function getCommodityAllocatedPegMatchIssues(
  coin: Pick<StablecoinMeta, "flags" | "reserves">,
): string[] {
  const issues: string[] = [];
  (coin.reserves ?? []).forEach((reserve, index) => {
    if (reserve.assetClass === "commodity-allocated" && !isCommodityPeg(coin.flags.pegCurrency)) {
      issues.push(
        `reserves[${index}] "${reserve.name}" uses assetClass commodity-allocated but pegCurrency ` +
          `${coin.flags.pegCurrency} is not a matching metal peg (allowed: ${COMMODITY_PEG_CURRENCIES.join(", ")})`,
      );
    }
  });
  return issues;
}

function getDependencyTotalIssue(coin: StablecoinMeta): string | null {
  if (!coin.dependencies || coin.dependencies.length === 0) return null;

  const total = coin.dependencies.reduce((sum, dependency) => sum + dependency.weight, 0);
  return total > 0 ? null : "dependency weight total must be greater than 0";
}

function dependencyKey(dependency: { id: string; type?: string }): string {
  return `${dependency.id}::${dependency.type ?? "collateral"}`;
}

export function getDependencyReserveOverlapIssues(coin: Pick<StablecoinMeta, "dependencies" | "reserves">): string[] {
  const dependencies = coin.dependencies ?? [];
  const linkedReserves = (coin.reserves ?? []).filter((reserve) => reserve.coinId);
  if (dependencies.length === 0 || linkedReserves.length === 0) return [];

  const reserveKeys = new Set(
    linkedReserves.map((reserve) => dependencyKey({ id: reserve.coinId!, type: reserve.depType })),
  );
  return [...new Set(dependencies.map(dependencyKey).filter((key) => reserveKeys.has(key)))].map(
    (key) =>
      `${key} is authored in both dependencies and linked reserves; keep reserve-backed relationships only in reserves`,
  );
}

function getReserveDependencyTypeLinkIssues(coin: StablecoinMeta): string[] {
  const issues: string[] = [];

  (coin.reserves ?? []).forEach((reserve, index) => {
    if (!reserve.depType || reserve.coinId) return;
    issues.push(
      `reserves[${index}] "${reserve.name}" sets depType="${reserve.depType}" without coinId; depType only applies to stablecoin-linked reserve slices`,
    );
  });

  return issues;
}

function getReferenceIssues(coin: StablecoinMeta, knownIds: ReadonlySet<string>): string[] {
  const issues: string[] = [];

  for (const dependency of coin.dependencies ?? []) {
    if (!knownIds.has(dependency.id)) {
      issues.push(`dependencies references unknown stablecoin ID "${dependency.id}"`);
    }
  }

  for (const reserve of coin.reserves ?? []) {
    if (reserve.coinId && !knownIds.has(reserve.coinId)) {
      issues.push(`reserves references unknown stablecoin ID "${reserve.coinId}"`);
    }
  }

  for (const relationship of coin.dependencyReview?.relationships ?? []) {
    if (!knownIds.has(relationship.id)) {
      issues.push(`dependencyReview references unknown stablecoin ID "${relationship.id}"`);
    }
  }

  for (const disposition of coin.reserveReview?.nonLinkDispositions ?? []) {
    for (const candidateId of disposition.candidateCoinIds ?? []) {
      if (!knownIds.has(candidateId)) {
        issues.push(`reserveReview references unknown candidate stablecoin ID "${candidateId}"`);
      }
    }
  }

  return issues;
}

/**
 * A review cannot predate the composition it reviewed. The V9 curated-admission
 * guard silently drops such compositions, so catch the inversion at authoring
 * time instead of losing the backing evidence at scoring time.
 */
function getReserveReviewDateOrderIssue(coin: StablecoinMeta): string | null {
  const review = coin.reserveReview;
  if (!review?.reviewedAt || !review.compositionAsOf) return null;
  if (review.reviewedAt >= review.compositionAsOf) return null;
  return `reserveReview.reviewedAt (${review.reviewedAt}) predates compositionAsOf (${review.compositionAsOf}); the curated reserve composition would be silently discarded`;
}

function getContractDeploymentIssues(coin: StablecoinMeta): string[] {
  const issues: string[] = [];
  const seen = new Map<string, string>();

  for (const listName of ["contracts", "tradedContracts"] as const) {
    const contracts = coin[listName] ?? [];

    contracts.forEach((contract, index) => {
      const path = `${listName}[${index}]`;
      const chainMeta = CHAIN_META[contract.chain];
      if (!chainMeta) {
        issues.push(`${path} uses unknown chain "${contract.chain}"`);
      } else if (chainMeta.type === "evm" && !/^0x[0-9a-fA-F]{40}$/.test(contract.address)) {
        issues.push(`${path} has invalid EVM address "${contract.address}"`);
      }

      const addressKey = chainMeta?.type === "evm" ? contract.address.toLowerCase() : contract.address;
      const key = `${contract.chain}:${addressKey}`;
      const previousPath = seen.get(key);
      if (previousPath) {
        issues.push(`${path} duplicates ${previousPath} (${key})`);
      } else {
        seen.set(key, path);
      }
    });
  }

  return issues;
}

function isTrackedRuntimeCoin(coin: StablecoinMeta): boolean {
  return isReadableStablecoinMeta(coin);
}

function getListingGovernanceIssues(coins: readonly StablecoinMeta[]): string[] {
  const issues: string[] = [];
  const decisionsResult = ListingDecisionRegistrySchema.safeParse(listingDecisionsAsset);
  if (!decisionsResult.success) {
    return decisionsResult.error.issues.map((issue) =>
      `listing-decisions.json[${issue.path.join(".")}]: ${issue.message}`
    );
  }

  const coinById = new Map(coins.map((coin) => [coin.id, coin]));
  const deadCoinIds = new Set(DEAD_STABLECOINS.map((coin) => coin.id));
  const listingClassById = new Map(Object.entries(decisionsResult.data.listingClassById));
  for (const [id, listingClass] of listingClassById) {
    if (!coinById.has(id) && !deadCoinIds.has(id)) {
      issues.push(`listing-decisions.json references unknown catalog ID "${id}"`);
    } else if (!coinById.has(id) && listingClass !== "excluded") {
      issues.push(`listing-decisions.json must classify cemetery ID "${id}" as excluded`);
    }
  }

  for (const coin of coins) {
    const listingClass = listingClassById.get(coin.id);
    if (!listingClass) {
      issues.push(`listing-decisions.json is missing catalog ID "${coin.id}"`);
      continue;
    }

    const expectedListingClass = coin.status === "delisted"
      ? "excluded"
      : coin.variantOf
        ? "stablecoin-variant"
        : coin.mechanismArchetype === "rwa-credit-fund"
          ? "stable-value-investment"
          : coin.flags.navToken === true || coin.mechanismArchetype === "tbill"
            ? "cash-equivalent"
            : "core-stablecoin";
    if (listingClass !== expectedListingClass) {
      issues.push(
        `listing-decisions.json class for "${coin.id}" is ${listingClass}; expected ${expectedListingClass}`,
      );
    }

    if (coin.status === "delisted") {
      if (listingClass !== "excluded") {
        issues.push(`listing-decisions.json must classify delisted "${coin.id}" as excluded`);
      }
    } else if (listingClass === "excluded") {
      issues.push(`listing-decisions.json marks non-delisted "${coin.id}" as excluded`);
    } else {
      if (coin.priceBasis != null) {
        issues.push(`priceBasis is reserved for sourced delisting records; remove it from "${coin.id}"`);
      }
      if (coin.exitMechanism != null) {
        issues.push(`exitMechanism is reserved for sourced delisting records; remove it from "${coin.id}"`);
      }
    }
  }

  return issues;
}

function getDeadStablecoinRegistryIssues(deadCoins: readonly DeadStablecoin[]): string[] {
  const issues: string[] = [];
  const seenIds = new Map<string, string>();
  const seenLlamaIds = new Map<string, string>();
  const seenContracts = new Map<string, string>();

  for (const dead of deadCoins) {
    const existingId = seenIds.get(dead.id);
    if (existingId) {
      issues.push(`duplicate cemetery id "${dead.id}" found in ${existingId} and ${dead.name}`);
    } else {
      seenIds.set(dead.id, dead.name);
    }

    if (dead.llamaId) {
      const existingLlamaId = seenLlamaIds.get(dead.llamaId);
      if (existingLlamaId) {
        issues.push(`duplicate cemetery llamaId "${dead.llamaId}" found in ${existingLlamaId} and ${dead.id}`);
      } else {
        seenLlamaIds.set(dead.llamaId, dead.id);
      }
    }

    for (const contract of dead.contracts ?? []) {
      const key = `${contract.chain}:${contract.address.toLowerCase()}`;
      const existingContract = seenContracts.get(key);
      if (existingContract) {
        issues.push(`duplicate cemetery contract "${key}" found in ${existingContract} and ${dead.id}`);
      } else {
        seenContracts.set(key, dead.id);
      }
    }
  }

  return issues;
}

function getTrackedDeadLlamaIdOverlapIssues(
  entries: readonly StablecoinSourceEntry[],
  deadCoins: readonly DeadStablecoin[],
): string[] {
  const issues: string[] = [];
  const deadByLlamaId = new Map<string, DeadStablecoin[]>();

  for (const dead of deadCoins) {
    if (!dead.llamaId) continue;
    const existing = deadByLlamaId.get(dead.llamaId);
    if (existing) {
      existing.push(dead);
    } else {
      deadByLlamaId.set(dead.llamaId, [dead]);
    }
  }

  for (const entry of entries) {
    if (!entry.coin.llamaId || !isTrackedRuntimeCoin(entry.coin)) continue;
    const deadMatches = deadByLlamaId.get(entry.coin.llamaId) ?? [];
    for (const dead of deadMatches) {
      const waiverKey = `${entry.coin.llamaId}::${entry.coin.id}::${dead.id}`;
      if (ACTIVE_DEAD_LLAMA_ID_OVERLAP_ALLOWLIST.has(waiverKey)) continue;
      issues.push(
        `${entry.file} (${entry.coin.id}): tracked runtime llamaId "${entry.coin.llamaId}" also appears in cemetery row "${dead.id}"`,
      );
    }
  }

  return issues;
}

function getLogoRegistryIssues(): string[] {
  let logoMap: unknown;
  try {
    logoMap = JSON.parse(readFileSync(LOGOS_FILE, "utf8")) as unknown;
  } catch (error) {
    return [`${LOGOS_FILE}: ${error instanceof Error ? error.message : String(error)}`];
  }

  if (!logoMap || typeof logoMap !== "object" || Array.isArray(logoMap)) {
    return [`${LOGOS_FILE}: expected object keyed by canonical stablecoin id`];
  }

  return Object.keys(logoMap)
    .filter((key) => /^\d+$/.test(key))
    .map((key) => `${LOGOS_FILE}: raw numeric DefiLlama logo key "${key}" must be migrated to a canonical id`);
}

function runStablecoinDataCheck(): void {
  let canonicalOrder: string[] = [];
  let perCoinEntries: StablecoinSourceEntry[] = [];

  canonicalOrder = readCanonicalOrder();

  for (const relativePath of findRecreatedRetiredStablecoinAssetFiles()) {
    reportError(formatRecreatedRetiredAssetFileIssue(relativePath));
  }

  try {
    perCoinEntries = loadPerCoinStablecoinEntries();
  } catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
  }

  try {
    loadGeneratedPerCoinCoins();
  } catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
  }

  if (errorCount === 0) {
    try {
      syncGeneratedPerCoinAsset({ check: true, entries: perCoinEntries });
      process.stdout.write(`${GENERATED_PER_COIN_ASSET_FILE}: generated aggregate is current\n`);
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
    }
  }

  if (errorCount === 0) {
    const allEntries = perCoinEntries;
    const knownIds = new Set(perCoinEntries.map((entry) => entry.coin.id));

    for (const issue of findDuplicateStablecoinIds(allEntries)) {
      reportError(
        `${STABLECOIN_DATA_DIR}: duplicate stablecoin id "${issue.id}" found in ${issue.entries.map((entry) => entry.file).join(", ")}`,
      );
    }

    for (const issue of getDeadStablecoinRegistryIssues(DEAD_STABLECOINS)) {
      reportError(`${STABLECOIN_DATA_DIR}/../dead-stablecoins.json: ${issue}`);
    }

    for (const issue of getTrackedDeadLlamaIdOverlapIssues(allEntries, DEAD_STABLECOINS)) {
      reportError(issue);
    }

    for (const issue of getLogoRegistryIssues()) {
      reportError(issue);
    }

    for (const issue of getListingGovernanceIssues(allEntries.map((entry) => entry.coin))) {
      reportError(`${STABLECOIN_DATA_DIR}: ${issue}`);
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
      for (const violation of validateMintBridgeOwnership(entry.coin, { enforce: true })) {
        const message = `${entry.file} (${entry.coin.id}) [${violation.code}] ${violation.path}: ${violation.message}`;
        reportError(message);
      }

      const reserveTotalIssue = getReserveTotalIssue(entry.coin);
      if (reserveTotalIssue) {
        reportError(`${entry.file} (${entry.coin.id}): ${reserveTotalIssue}`);
      }

      for (const reservePublicLabelIssue of getReservePublicLabelIssues(entry.coin)) {
        reportError(`${entry.file} (${entry.coin.id}): ${reservePublicLabelIssue}`);
      }

      const dependencyTotalIssue = getDependencyTotalIssue(entry.coin);
      if (dependencyTotalIssue) {
        reportError(`${entry.file} (${entry.coin.id}): ${dependencyTotalIssue}`);
      }

      for (const pegMatchIssue of getCommodityAllocatedPegMatchIssues(entry.coin)) {
        reportError(`${entry.file} (${entry.coin.id}): ${pegMatchIssue}`);
      }

      for (const overlapIssue of getDependencyReserveOverlapIssues(entry.coin)) {
        reportError(`${entry.file} (${entry.coin.id}): ${overlapIssue}`);
      }

      for (const reserveDependencyTypeLinkIssue of getReserveDependencyTypeLinkIssues(entry.coin)) {
        reportError(`${entry.file} (${entry.coin.id}): ${reserveDependencyTypeLinkIssue}`);
      }

      const algorithmicBackingIssue = getTrackedAlgorithmicBackingIssue(entry.coin);
      if (algorithmicBackingIssue) {
        reportError(`${entry.file} (${entry.coin.id}): ${algorithmicBackingIssue}`);
      }

      const runtimeAdmissionIssue = getRuntimeAdmissionIssue(entry.coin);
      if (runtimeAdmissionIssue) {
        reportError(`${entry.file} (${entry.coin.id}): ${runtimeAdmissionIssue}`);
      }

      const commodityOuncesIssue = getCommodityOuncesIssue(entry.coin);
      if (commodityOuncesIssue) {
        reportError(`${entry.file} (${entry.coin.id}): ${commodityOuncesIssue}`);
      }

      const commodityProtocolSlugIssue = getCommodityProtocolSlugIssue(entry.coin);
      if (commodityProtocolSlugIssue) {
        reportWarning(`${entry.file} (${entry.coin.id}): ${commodityProtocolSlugIssue}`);
      }

      const pegRuntimeSupportIssue = getPegRuntimeSupportIssue(entry.coin);
      if (pegRuntimeSupportIssue) {
        reportError(`${entry.file} (${entry.coin.id}): ${pegRuntimeSupportIssue}`);
      }

      const reserveReviewDateOrderIssue = getReserveReviewDateOrderIssue(entry.coin);
      if (reserveReviewDateOrderIssue) {
        reportError(`${entry.file} (${entry.coin.id}): ${reserveReviewDateOrderIssue}`);
      }

      for (const referenceIssue of getReferenceIssues(entry.coin, knownIds)) {
        reportError(`${entry.file} (${entry.coin.id}): ${referenceIssue}`);
      }

      for (const contractIssue of getContractDeploymentIssues(entry.coin)) {
        reportError(`${entry.file} (${entry.coin.id}): ${contractIssue}`);
      }
    }

    for (const error of validateVariantRelationships(allEntries.map((entry) => entry.coin))) {
      reportError(`${STABLECOIN_DATA_DIR}: ${error}`);
    }

    for (const issue of findBlacklistabilityReviewIssues(allEntries.map((entry) => entry.coin))) {
      reportError(`${STABLECOIN_DATA_DIR}: ${issue.id}: ${issue.message}`);
    }

    // Advisory only: catches `collateral` prose written from a
    // governance-approved/eligible asset list instead of the observed balances
    // the reviewed slices record (the frxUSD USCC/JTRSY/AUSD defect). Tier 2 is
    // the tolerated noise floor (look-through and taxonomy naming), so only its
    // count is printed.
    const collateralDrift = findCollateralProseReserveDriftFindings(allEntries.map((entry) => entry.coin));
    for (const finding of collateralDrift.filter((candidate) => candidate.tier === 1)) {
      reportWarning(`${STABLECOIN_DATA_DIR}: ${finding.coinId}: ${finding.message}`);
    }
    const collateralDriftTier2 = collateralDrift.filter((candidate) => candidate.tier === 2).length;
    if (collateralDriftTier2 > 0) {
      process.stdout.write(
        `note: ${collateralDriftTier2} further coin(s) name a tracked symbol absent from their reviewed reserve ` +
          `slices without eligibility modality (look-through / taxonomy naming; not reviewed as drift).\n`,
      );
    }
  }

  if (errorCount > 0) {
    process.stderr.write(`\n${errorCount} error(s) found in stablecoin data files.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    warningCount > 0 ? `Stablecoin data validation: OK (${warningCount} warning(s))\n` : "Stablecoin data validation: OK\n",
  );
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runStablecoinDataCheck();
}
