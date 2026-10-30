import { compareCodeUnits } from "@shared/lib/compare";
import { isFixedDecimalDeployment } from "@shared/lib/deployment-amounts";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { resolveChainId } from "@shared/types/chain-identity";
import type { StablecoinMeta } from "@shared/types/core";
import {
  deploymentSupplyCensusRejectionCode,
  type SafetyScoreV9DeploymentSupplyCensus,
  type SafetyScoreV9DeploymentSupplyCensusById,
  type V9DeploymentSupplyCensusRejection,
  type V9DeploymentSupplyCensusRejectionReason,
  type V9DeploymentSupplyCensusRow,
} from "@shared/types/safety-score-v9-deployment-supply-census";
import { normalizeDeploymentId } from "@shared/types/deployment-id";
import { rethrowIfAborted, throwIfAborted } from "../abort";
import type { ChainRpcConfig } from "../chain-registry";
import type { DwellirNativeCapability } from "../dwellir-native";
import type { EvmRpcOptions } from "../evm-rpc";
import {
  DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET,
  observeDeploymentSupplyCensusEvm,
  resolveDeploymentSupplyCensusEvmPins,
  type DeploymentSupplyCensusChainRead,
  type DeploymentSupplyCensusEvmCensus,
  type DeploymentSupplyCensusEvmDependencies,
  type DeploymentSupplyCensusEvmPinResolution,
  type DeploymentSupplyCensusMeasuredRow,
  type DeploymentSupplyCensusReadTarget,
  type DeploymentSupplyCensusReferencePrice,
} from "./deployment-supply-census-evm";
import {
  deploymentSupplyCensusChainReadKind,
  deploymentSupplyCensusPinSkewIssue,
  observeDeploymentSupplyCensusNonEvmChain,
  type DeploymentSupplyCensusNonEvmDependencies,
} from "./deployment-supply-census-nonevm";
import {
  createSafetyScoreV9DeploymentSupplyCensusGeneration,
  type SafetyScoreV9DeploymentSupplyCensusGeneration,
} from "./deployment-supply-census-store";
import {
  REVIEWED_ECONOMIC_SUPPLY_PLANS,
  REVIEWED_PROVIDER_CHAIN_PARTITIONS,
  economicSupplyInputReferencePrice,
  normalizeReviewedDeploymentAddress,
  reviewedSupplyRouteKind,
} from "./supply-attribution-contract";
import type { SafetyScoreV9SupplyAttributionInput } from "./supply-attribution-source";

/**
 * One assembled `deployment-supply-census-v1` generation (WS6 / 4a, PLAN §4.6).
 *
 * The producer enumerates each asset's reviewed deployment inventory
 * (`bridgeRouteRisk.routes[]` with `reviewDisposition: "reviewed"`), reads one
 * pinned `totalSupply` per deployment through SA-2a (EVM) and SA-2b
 * (Solana/Move), and assembles the per-asset fixed-input packet
 * (`{model, observedAtSec, deployments[], conservation, rejected[]}`).
 *
 * Admission gates are fail-closed (R1–R8):
 * - the roster is the authored inventory; a route that is not reviewed, is not
 *   its own normalized `chain:contractAddress`, has no authored deployment, or
 *   has no admitted read kind rejects the WHOLE asset (`deployments: []`): a
 *   partial partition never becomes evidence;
 * - conservation is recomputed from the packet's own rows (C4 M-9): equal
 *   shares are not trusted, and `Σ shareUpper` over the audited aggregate is a
 *   `census-rejected:conservation-breach` that names every measured deployment;
 * - tier 0 bounds every read deployment on a chain by the provider's
 *   `chainCirculatingById` allocation for that chain; a missing chain row is
 *   never a fabricated pass and a breach names the chain's deployments;
 * - pins carry their block/slot/ledger (and EVM runtime code hash) and age
 *   against the one supply-attribution authority; cross-chain skew is checked
 *   across the whole asset, not only inside the EVM half;
 * - a deployment at or above the 1% documentation bar stays in `deployments[]`
 *   as an upper bound: rejecting it producer-side would hide the measured bound
 *   from `deployment-supply-share-requires-reviewed-escrow` (OP-R0 S-15).
 *
 * Budget: the cohort carries at most `DEPLOYMENT_SUPPLY_CENSUS_MAX_ASSETS`
 * assets and `DEPLOYMENT_SUPPLY_CENSUS_MAX_DEPLOYMENTS_PER_RUN` deployments
 * (PLAN §4.6 reuses `TRANSFER_MATERIALITY_CAPTURE_BUDGET`); over-cap input is
 * refused rather than truncated so a generation is never partial. EVM chains
 * are pinned once per run and read through the census EVM budget (3 in flight,
 * 768 requests); Solana is captured before the historical readers because a
 * finalized snapshot cannot be rewound. Shadow only: nothing here reaches a
 * score until v10.38 admission (SA-3) and capture wiring (SA-4).
 */

const CENSUS_POLICY = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.deploymentSupplyCensus;
const SUPPLY_POLICY = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;

/** Cohort cap copied from `TRANSFER_MATERIALITY_CAPTURE_BUDGET.maxAssets` (PLAN §4.6). */
export const DEPLOYMENT_SUPPLY_CENSUS_MAX_ASSETS = 96;
/** Per-run deployment cap copied from `TRANSFER_MATERIALITY_CAPTURE_BUDGET.maxDeploymentsPerRun`. */
export const DEPLOYMENT_SUPPLY_CENSUS_MAX_DEPLOYMENTS_PER_RUN = 256;

/** Registry projection the assembly enumerates. Tests supply a fixture map. */
export type DeploymentSupplyCensusRegistryMeta = Pick<StablecoinMeta, "id" | "contracts" | "bridgeRouteRisk">;

/**
 * `safetyScoreV9DeploymentSupplyCensusById` input. The supply-attribution input
 * carries the audited aggregate and provider chain rows; `pegDataById` supplies
 * the reference price fallback the economic plans do not cover.
 */
export interface DeploymentSupplyCensusAssemblyInput {
  readonly fixedInput: Readonly<
    SafetyScoreV9SupplyAttributionInput & {
      readonly pegDataById?: Readonly<Record<string, {
        readonly pegReference?: { readonly valueUsd: number; readonly asOf: number } | null;
      } | undefined>>;
    }
  >;
  readonly assetIds: readonly string[];
  /**
   * The instant this run observes the chains. Pins resolve at or before it, pin
   * and price age are measured against it, and every packet and the generation
   * carry it as `observedAtSec`.
   *
   * It is not the fixed-input clock: the census runs in the 30-minute
   * attribution slot, which is later than the prepare clock the source carries,
   * and a finalized Solana snapshot cannot be rewound to that earlier instant.
   * Ageing a run-time snapshot against the prepare clock rejected every non-EVM
   * leg `future-dated-pin` (2026-10-30 first cycle). The bound is aged by the
   * consumer against the clock of the publication that reads it, which is later
   * than this instant (bound window 5,400 s).
   */
  readonly observationClockSec: number;
  readonly chainRpcs: Map<string, ChainRpcConfig>;
  readonly dwellirNative?: DwellirNativeCapability;
  readonly signal?: AbortSignal;
  /** Absolute preparation/slot deadline; readers reserve their own publication window. */
  readonly deadlineMs?: number;
  readonly beforeRequest?: EvmRpcOptions["beforeRequest"];
  readonly metaById?: ReadonlyMap<string, DeploymentSupplyCensusRegistryMeta>;
}

/** DI seam: replay a recorded generation through the same readers. */
export interface DeploymentSupplyCensusAssemblyDependencies {
  readonly evm?: Partial<DeploymentSupplyCensusEvmDependencies>;
  readonly nonEvm?: Partial<DeploymentSupplyCensusNonEvmDependencies>;
}

interface CensusRosterEntry {
  readonly routeId: string;
  readonly chainId: string;
  readonly tokenAddress: string;
  readonly readKind: V9DeploymentSupplyCensusRow["readKind"];
  readonly expectedDecimals: number | null;
  /** This route is the asset's canonical issuance on its chain. */
  readonly canonicalDeployment: boolean;
  /**
   * For a lock-mint representation: the chain whose deployment's total supply
   * already contains the escrowed backing of this route's minted supply.
   */
  readonly mirroredFromChainId: string | null;
  readonly target: DeploymentSupplyCensusReadTarget;
}

interface AssetCensusAccumulator {
  readonly assetId: string;
  readonly aggregateSupplyUsd: number | null;
  readonly chainSupplyUsdByChainId: ReadonlyMap<string, number>;
  readonly referencePrice: DeploymentSupplyCensusReferencePrice | null;
  readonly entries: readonly CensusRosterEntry[];
  /** Wire rejections keyed by `routeId:code`, so one cause is named once. */
  readonly rejected: Map<string, V9DeploymentSupplyCensusRejection>;
  readonly rows: Map<string, V9DeploymentSupplyCensusRow>;
}

function rejection(
  routeId: string | null,
  reason: V9DeploymentSupplyCensusRejectionReason,
): V9DeploymentSupplyCensusRejection {
  return { routeId, code: deploymentSupplyCensusRejectionCode(reason) };
}

function rejectionKey(entry: V9DeploymentSupplyCensusRejection): string {
  return `${entry.routeId ?? "*"}\u0000${entry.code}`;
}

function addRejection(
  rejected: Map<string, V9DeploymentSupplyCensusRejection>,
  routeId: string | null,
  reason: V9DeploymentSupplyCensusRejectionReason,
): void {
  const entry = rejection(routeId, reason);
  rejected.set(rejectionKey(entry), entry);
}

function sortedRejections(rejected: ReadonlyMap<string, V9DeploymentSupplyCensusRejection>): V9DeploymentSupplyCensusRejection[] {
  return [...rejected.values()].sort((left, right) =>
    compareCodeUnits(left.routeId ?? "", right.routeId ?? "") || compareCodeUnits(left.code, right.code));
}

/**
 * Provider chain allocation per canonical chain. Alias labels denote one chain
 * allocation (mirroring `canonicalEligibleProviderSupply`); an unusable row
 * contributes no bound rather than a fabricated one.
 */
function providerChainSupplyUsd(
  rows: Readonly<Record<string, { readonly current: number }>>,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const [label, row] of Object.entries(rows)) {
    if (!Number.isFinite(row.current) || row.current < 0) continue;
    const chainId = resolveChainId(label) ?? label;
    const total = (totals.get(chainId) ?? 0) + row.current;
    if (Number.isFinite(total)) totals.set(chainId, total);
  }
  return totals;
}

/**
 * Reference price for the deployment unit: the admitted NAV price first (the
 * economic-supply authority), then the peg reference. Both carry their own
 * observation clock; a missing price is `reference-price-unavailable`, never 1.
 */
function assetReferencePrice(
  fixedInput: DeploymentSupplyCensusAssemblyInput["fixedInput"],
  assetId: string,
): DeploymentSupplyCensusReferencePrice | null {
  const nav = economicSupplyInputReferencePrice(fixedInput, assetId);
  if (nav !== null) {
    const priceUsd = Number(nav.value);
    if (Number.isFinite(priceUsd) && priceUsd > 0) {
      return { priceUsd, observedAtSec: nav.observedAtSec };
    }
  }
  const peg = fixedInput.pegDataById?.[assetId]?.pegReference;
  if (
    peg !== undefined && peg !== null &&
    Number.isFinite(peg.valueUsd) && peg.valueUsd > 0 &&
    Number.isSafeInteger(peg.asOf) && peg.asOf >= 0
  ) {
    return { priceUsd: peg.valueUsd, observedAtSec: peg.asOf };
  }
  return null;
}

function contractDecimals(
  meta: DeploymentSupplyCensusRegistryMeta,
  chainId: string,
  tokenAddress: string,
): { readonly expectedDecimals: number | null } | { readonly reason: V9DeploymentSupplyCensusRejectionReason } {
  const contract = (meta.contracts ?? []).find(candidate =>
    (resolveChainId(candidate.chain) ?? candidate.chain) === chainId &&
    normalizeReviewedDeploymentAddress(chainId, candidate.address) === tokenAddress);
  if (contract === undefined) {
    // The reviewed route is not one of the asset's authored deployments.
    return { reason: "roster-incomplete" };
  }
  if (!isFixedDecimalDeployment(contract)) {
    // XRPL issued currencies and unpriced native denoms are not fixed-token-unit reads.
    return { reason: "unresolved-amount-basis" };
  }
  return { expectedDecimals: contract.decimals };
}

interface RosterBuild {
  readonly entries: readonly CensusRosterEntry[];
  readonly rejected: Map<string, V9DeploymentSupplyCensusRejection>;
}

/**
 * Enumerate one asset's reviewed deployment roster. Anything that cannot be an
 * exact fixed-token-unit read rejects the route, which blocks the asset because
 * a partial roster proves nothing (R1/R4).
 */
function buildRoster(
  meta: DeploymentSupplyCensusRegistryMeta,
): RosterBuild {
  const rejected = new Map<string, V9DeploymentSupplyCensusRejection>();
  const entries: CensusRosterEntry[] = [];
  const routes = meta.bridgeRouteRisk?.routes ?? [];
  const seen = new Set<string>();
  for (const route of routes) {
    const routeId = route.id;
    if (seen.has(routeId)) {
      addRejection(rejected, null, "roster-incomplete");
      continue;
    }
    seen.add(routeId);
    if (route.reviewDisposition !== "reviewed") {
      addRejection(rejected, routeId, "route-unreviewed");
      continue;
    }
    const chainId = resolveChainId(route.destinationChain);
    if (chainId === null) {
      addRejection(rejected, routeId, "route-unreviewed");
      continue;
    }
    const tokenAddress = normalizeReviewedDeploymentAddress(chainId, route.contractAddress);
    if (routeId !== normalizeDeploymentId(`${chainId}:${tokenAddress}`)) {
      // The route id must be the address it names; never rewrite an identity.
      addRejection(rejected, routeId, "route-unreviewed");
      continue;
    }
    const readKind = deploymentSupplyCensusChainReadKind(chainId);
    if (readKind === null) {
      // No admitted historical read for this chain family: the deployment's
      // supply stays null; do not invent a quantity.
      addRejection(rejected, routeId, "read-unavailable");
      continue;
    }
    const decimals = contractDecimals(meta, chainId, tokenAddress);
    if ("reason" in decimals) {
      addRejection(rejected, routeId, decimals.reason);
      continue;
    }
    // `semantics`/`scope`/`canonicalChain` are reviewed route facts; a
    // lock-mint representation is minted against canonical supply that is
    // already inside the canonical deployment's totalSupply.
    const routeFacts = route as {
      readonly semantics?: unknown; readonly scope?: unknown;
      readonly canonicalChain?: unknown; readonly sourceChain?: unknown;
    };
    const canonicalLabel = routeFacts.canonicalChain ?? routeFacts.sourceChain;
    const mirroredFromChainId = routeFacts.semantics === "lock-mint" && routeFacts.scope !== "canonical" &&
      typeof canonicalLabel === "string"
      ? resolveChainId(canonicalLabel)
      : null;
    entries.push({
      routeId,
      chainId,
      tokenAddress,
      readKind,
      expectedDecimals: decimals.expectedDecimals,
      canonicalDeployment: routeFacts.scope === "canonical",
      mirroredFromChainId,
      target: {
        assetId: meta.id,
        chainId,
        tokenAddress,
        routeId,
        expectedDecimals: decimals.expectedDecimals,
      },
    });
  }
  // The authored deployments are the roster, not only the routes: a deployment
  // the route inventory forgets would make the partition look conserved while
  // silently omitting supply.
  for (const contract of meta.contracts ?? []) {
    if (!isFixedDecimalDeployment(contract)) continue;
    const chainId = resolveChainId(contract.chain);
    if (chainId === null) continue;
    const tokenAddress = normalizeReviewedDeploymentAddress(chainId, contract.address);
    const identity = normalizeDeploymentId(`${chainId}:${tokenAddress}`);
    if (!seen.has(identity)) {
      addRejection(rejected, null, "roster-incomplete");
      break;
    }
  }
  return { entries, rejected };
}

/** The assembly refuses the 65th deployment; the cohort must never spend a slot on it. */
export const DEPLOYMENT_SUPPLY_CENSUS_PER_ASSET_CAP = CENSUS_POLICY.maxDeploymentsPerAsset;

/** One asset's census target: how many open null-share deployments the census could close. */
export interface DeploymentSupplyCensusTarget {
  readonly assetId: string;
  /** Reviewed representation deployments without a reviewed `materialSupplyShare`. */
  readonly gapRoutes: number;
  /** Measurable reviewed deployments the run must read (the deployment budget). */
  readonly reviewedRoutes: number;
  /** Every authored route; the per-asset cap counts all of them. */
  readonly rosterRoutes: number;
  /** Deployments read through the EVM request budget; defaults to `reviewedRoutes`. */
  readonly evmRoutes?: number;
  /** Distinct EVM chains whose pin is charged once per run; defaults to none. */
  readonly evmChains?: readonly string[];
}

/**
 * Deterministic request estimate for one run, so the cohort can be sized
 * before any chain read starts instead of being clipped mid-run (which leaves
 * the tail assets rejected `read-unavailable` after spending their share).
 *
 * - one `eth_getCode` per EVM deployment (runtime hash gate);
 * - one Multicall3 supply read per `evmMulticallMaxBatchSize` deployments;
 * - one pin reservation per EVM chain, resolved once for the whole run. 32
 *   probes covers an admitted fixed input (the source may be one prepare
 *   interval old): Base at 200 ms blocks needs ~2*log2(9,000) ≈ 28 probes for
 *   a 30-minute bracket; a near-tip clock needs far fewer;
 * - two attempts of slack for a fallback/retry on the first physical request.
 * The estimate deliberately charges the full pin bracket even though a
 * chain's pin is shared by every selected asset on it.
 */
export const DEPLOYMENT_SUPPLY_CENSUS_REQUEST_ESTIMATE = Object.freeze({
  pinProbesPerChain: 32,
  perAssetSlack: 2,
});

export function deploymentSupplyCensusRequestCost(
  target: DeploymentSupplyCensusTarget,
  newChainCount: number,
): number {
  const evmRoutes = target.evmRoutes ?? target.reviewedRoutes;
  if (evmRoutes === 0) return 0;
  const supplyReads = Math.ceil(evmRoutes / CENSUS_POLICY.evmMulticallMaxBatchSize);
  return evmRoutes + supplyReads +
    newChainCount * DEPLOYMENT_SUPPLY_CENSUS_REQUEST_ESTIMATE.pinProbesPerChain +
    DEPLOYMENT_SUPPLY_CENSUS_REQUEST_ESTIMATE.perAssetSlack;
}

/** Cohort plus the assets the run budget could not fit (they stay open). */
export interface DeploymentSupplyCensusCohortSelection {
  readonly assetIds: readonly string[];
  /** Ranked candidates left with every gap route still open. */
  readonly skippedAssetIds: readonly string[];
  readonly estimatedRequests: number;
}

function routeChainOf(routeId: string): string | null {
  const separator = routeId.indexOf(":");
  return separator > 0 ? resolveChainId(routeId.slice(0, separator)) : null;
}

/**
 * Open census-closable gaps, derived from the same registry and prepared-input
 * projections the consumer's supply review reads — never from roster size.
 *
 * An asset is a target only when its whole authored roster is measurable (a
 * partial roster rejects the asset wholesale) and no reviewed economic plan or
 * reviewed economic deployment partition already resolves its shares. A
 * reviewed representation deployment is unresolved when the prepared input
 * leaves it without a reviewed share row: no provider chain row for its chain,
 * more than one candidate route on that chain without a reviewed chain
 * partition, or a deployment-unit partition (which never sets a share).
 */
export function deploymentSupplyCensusTargets(input: {
  readonly assetIds: readonly string[];
  readonly metaById: ReadonlyMap<string, DeploymentSupplyCensusRegistryMeta>;
  readonly chainCirculatingById: Readonly<
    Record<string, Readonly<Record<string, { readonly current: number }>>>
  >;
  /** Attribution packets already injected into the prepared input, by asset. */
  readonly supplyAttributionById?: Readonly<Record<string, { readonly model: string }>>;
}): DeploymentSupplyCensusTarget[] {
  const targets: DeploymentSupplyCensusTarget[] = [];
  for (const assetId of new Set(input.assetIds)) {
    const meta = input.metaById.get(assetId);
    const routes = meta?.bridgeRouteRisk?.routes ?? [];
    if (meta === undefined || routes.length === 0) continue;
    if (routes.length > DEPLOYMENT_SUPPLY_CENSUS_PER_ASSET_CAP) continue;
    const roster = buildRoster(meta);
    if (roster.rejected.size > 0 || roster.entries.length === 0) continue;
    const routeById = new Map(routes.map(route => [route.id, route] as const));
    const hasReviewedPlan = REVIEWED_ECONOMIC_SUPPLY_PLANS.has(assetId);
    // Only the attribution packet in the prepared input allocates reviewed
    // per-deployment shares; a reviewed plan without it leaves the deployment
    // datum unresolved, which is exactly what the census can bound.
    const covered =
      input.supplyAttributionById?.[assetId]?.model === "reviewed-economic-deployment-partition-v1";
    const chainSupplyUsd = providerChainSupplyUsd(input.chainCirculatingById[assetId] ?? {});
    const chainPartitions = new Set(
      REVIEWED_PROVIDER_CHAIN_PARTITIONS.getAll(assetId).map(review => review.chainId),
    );
    const candidateRoutesByChain = new Map<string, number>();
    for (const route of routes) {
      const chain = routeChainOf(route.id);
      if (chain !== null) candidateRoutesByChain.set(chain, (candidateRoutesByChain.get(chain) ?? 0) + 1);
    }
    let gapRoutes = 0;
    for (const entry of roster.entries) {
      const route = routeById.get(entry.routeId);
      if (route === undefined) continue;
      const representation = hasReviewedPlan
        ? reviewedSupplyRouteKind(route, meta.bridgeRouteRisk) === "controlled"
        : route.routeClass !== "native" && route.issuanceModel !== "native-issuance";
      if (!representation || covered) continue;
      // A reviewed chain partition is the reviewed split, not an ambiguous chain.
      if (chainPartitions.has(entry.chainId)) continue;
      // No provider row for the chain: the review has no share to allocate.
      if (!chainSupplyUsd.has(entry.chainId)) {
        gapRoutes += 1;
        continue;
      }
      // More than one candidate deployment on the chain and no reviewed split:
      // the chain row stays an ambiguous residual, so the share is unresolved.
      if ((candidateRoutesByChain.get(entry.chainId) ?? 0) !== 1) gapRoutes += 1;
    }
    targets.push({
      assetId,
      gapRoutes,
      reviewedRoutes: roster.entries.length,
      rosterRoutes: routes.length,
      evmRoutes: roster.entries.filter(entry => entry.readKind === "evm-total-supply").length,
      evmChains: [...new Set(roster.entries
        .filter(entry => entry.readKind === "evm-total-supply")
        .map(entry => entry.chainId))].sort(compareCodeUnits),
    });
  }
  return targets;
}

/** Exact token units to USD, nudged up so an upper bound never under-states. */
function totalSupplyUsdUpper(rawSupply: string, decimals: number, priceUsd: number): number | null {
  const usd = (Number(rawSupply) / 10 ** decimals) * priceUsd;
  if (!Number.isFinite(usd) || usd < 0) return null;
  return usd * (1 + Number.EPSILON * 8);
}

/**
 * Re-expresses raw token units in another deployment's decimals. Truncates, so
 * a mirrored amount is a lower bound and the net canonical float stays an
 * upper bound.
 */
function scaleRawUnits(value: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return value;
  return fromDecimals > toDecimals
    ? value / 10n ** BigInt(fromDecimals - toDecimals)
    : value * 10n ** BigInt(toDecimals - fromDecimals);
}

function measuredRow(
  entry: CensusRosterEntry,
  measurement: DeploymentSupplyCensusMeasuredRow,
  price: DeploymentSupplyCensusReferencePrice,
  aggregateSupplyUsd: number,
): V9DeploymentSupplyCensusRow | { readonly reason: V9DeploymentSupplyCensusRejectionReason } {
  const supplyUsdUpper = totalSupplyUsdUpper(measurement.totalSupplyRaw, measurement.decimals, price.priceUsd);
  if (supplyUsdUpper === null) return { reason: "read-unavailable" };
  return {
    routeId: entry.routeId,
    chainId: entry.chainId,
    tokenAddress: entry.tokenAddress,
    readKind: entry.readKind,
    pin: measurement.pin,
    decimals: measurement.decimals,
    totalSupplyRaw: measurement.totalSupplyRaw,
    referencePriceUsd: price.priceUsd,
    referencePriceObservedAtSec: price.observedAtSec,
    supplyUsdUpper,
    shareUpper: supplyUsdUpper / aggregateSupplyUsd,
    evidenceKind: "upper-bound",
  };
}

function priceRejection(
  clockSec: number,
  price: DeploymentSupplyCensusReferencePrice | null,
): V9DeploymentSupplyCensusRejectionReason | null {
  if (price === null || !Number.isFinite(price.priceUsd) || price.priceUsd <= 0) {
    return "reference-price-unavailable";
  }
  const ageSec = clockSec - price.observedAtSec;
  if (ageSec < 0) return "future-dated-pin";
  if (ageSec > SUPPLY_POLICY.observationMaxAgeSec) return "reference-price-unavailable";
  return null;
}

/**
 * Assemble one asset's packet from its measured rows and rejections.
 *
 * `rosterComplete` names whether every reviewed deployment was measured, which
 * is what lets the consumer tell `roster-incomplete` from a measured partition
 * that fails conservation. Rows are admitted only when the partition is
 * conserved: a rejected packet carries no rows, so no consumer can read a
 * partial partition even if it ignores `conserved`.
 */
function assemblePacket(
  accumulator: AssetCensusAccumulator,
  clockSec: number,
): SafetyScoreV9DeploymentSupplyCensus {
  const aggregateSupplyUsd = accumulator.aggregateSupplyUsd ?? 0;
  let rows = [...accumulator.rows.values()].sort((left, right) => compareCodeUnits(left.routeId, right.routeId));
  const rosterComplete = accumulator.rejected.size === 0 && rows.length === accumulator.entries.length;

  if (rosterComplete) {
    const skewIssue = deploymentSupplyCensusPinSkewIssue(rows.map(row => row.pin));
    if (skewIssue !== null) {
      for (const row of rows) addRejection(accumulator.rejected, row.routeId, skewIssue);
      rows = [];
    }
  }

  if (rosterComplete && rows.length > 0) {
    // Lock-mint representations are minted against canonical supply that is
    // already inside the canonical deployment's totalSupply. Summing both
    // reports one liability twice (witry-brix: canonical 5,359,342 + MegaETH
    // mirror 5,358,239 against a 5,359,342 aggregate). The canonical
    // deployment's circulating bound is its total supply minus the escrowed
    // mirrors, so the partition sums to the canonical total — the same
    // subtraction the reviewed cEUR record states ("subtracting the
    // then-observed three legacy representations"). Burn-mint routes never
    // subtract: their canonical supply is destroyed on transfer.
    const entryByRouteId = new Map(accumulator.entries.map(entry => [entry.routeId, entry] as const));
    const mirrorsByCanonicalChain = new Map<string, V9DeploymentSupplyCensusRow[]>();
    for (const row of rows) {
      const mirroredFrom = entryByRouteId.get(row.routeId)?.mirroredFromChainId ?? null;
      if (mirroredFrom === null) continue;
      const list = mirrorsByCanonicalChain.get(mirroredFrom);
      if (list === undefined) mirrorsByCanonicalChain.set(mirroredFrom, [row]);
      else list.push(row);
    }
    let unreconciled = false;
    const adjustedRows: V9DeploymentSupplyCensusRow[] = [];
    for (const row of rows) {
      const mirrors = entryByRouteId.get(row.routeId)?.canonicalDeployment === true
        ? mirrorsByCanonicalChain.get(row.chainId) ?? []
        : [];
      const mirroredUnits = mirrors.reduce(
        (sum, mirror) => sum + scaleRawUnits(BigInt(mirror.totalSupplyRaw), mirror.decimals, row.decimals),
        0n,
      );
      if (mirroredUnits === 0n) {
        adjustedRows.push(row);
        continue;
      }
      const netRaw = BigInt(row.totalSupplyRaw) - mirroredUnits;
      if (netRaw < 0n) {
        // Mirrors claim more than the canonical deployment holds: the reads
        // cannot form a partition. Fail closed rather than clamp to zero.
        unreconciled = true;
        break;
      }
      const supplyUsdUpper = totalSupplyUsdUpper(netRaw.toString(), row.decimals, row.referencePriceUsd);
      if (supplyUsdUpper === null || !(aggregateSupplyUsd > 0)) {
        unreconciled = true;
        break;
      }
      adjustedRows.push({
        ...row,
        totalSupplyRaw: netRaw.toString(),
        supplyUsdUpper,
        shareUpper: supplyUsdUpper / aggregateSupplyUsd,
      });
    }
    if (unreconciled) {
      for (const row of rows) addRejection(accumulator.rejected, row.routeId, "conservation-breach");
      rows = [];
    } else {
      rows = adjustedRows;
    }
  }

  if (rosterComplete && rows.length > 0) {
    // Tier 0: a chain's measured partition cannot exceed the provider's
    // allocation for that chain on this asset. A missing allocation is not a
    // pass; it leaves the rows as upper bounds and the asset-level sum decides.
    const measuredUsdByChain = new Map<string, number>();
    for (const row of rows) {
      measuredUsdByChain.set(row.chainId, (measuredUsdByChain.get(row.chainId) ?? 0) + row.supplyUsdUpper);
    }
    const breachedChains = new Set<string>();
    for (const [chainId, measuredUsd] of measuredUsdByChain) {
      const chainBoundUsd = accumulator.chainSupplyUsdByChainId.get(chainId);
      if (chainBoundUsd === undefined || !Number.isFinite(chainBoundUsd) || chainBoundUsd < 0) continue;
      const ceilingUsd = chainBoundUsd * (1 + SUPPLY_POLICY.conservationRelativeTolerance) +
        SUPPLY_POLICY.conservationAbsoluteToleranceUsd;
      if (measuredUsd > ceilingUsd) breachedChains.add(chainId);
    }
    if (breachedChains.size > 0) {
      for (const row of rows) {
        if (breachedChains.has(row.chainId)) addRejection(accumulator.rejected, row.routeId, "conservation-breach");
      }
      rows = [];
    }
  }

  if (rosterComplete && rows.length > 0) {
    // Row-derived conservation (C4 M-9): the declared totals are the rows', and
    // an over-counting partition names every measured deployment.
    const measuredSupplyUsd = rows.reduce((sum, row) => sum + row.supplyUsdUpper, 0);
    const ceilingUsd = aggregateSupplyUsd * (1 + SUPPLY_POLICY.conservationRelativeTolerance) +
      SUPPLY_POLICY.conservationAbsoluteToleranceUsd;
    if (aggregateSupplyUsd <= 0 || measuredSupplyUsd > ceilingUsd) {
      for (const row of rows) addRejection(accumulator.rejected, row.routeId, "conservation-breach");
      rows = [];
    }
  }

  const conserved = rosterComplete && rows.length === accumulator.entries.length && accumulator.rejected.size === 0;
  const deployments = conserved ? rows : [];
  return {
    model: "deployment-supply-census-v1",
    observedAtSec: clockSec,
    deployments,
    conservation: {
      aggregateSupplyUsd,
      measuredSupplyUsd: deployments.reduce((sum, row) => sum + row.supplyUsdUpper, 0),
      measuredShareSum: deployments.reduce((sum, row) => sum + row.shareUpper, 0),
      relativeTolerance: SUPPLY_POLICY.conservationRelativeTolerance,
      absoluteToleranceUsd: SUPPLY_POLICY.conservationAbsoluteToleranceUsd,
      rosterComplete,
      conserved,
    },
    rejected: sortedRejections(accumulator.rejected),
  };
}

/**
 * Runs one census generation. The cohort is supplied by capture (SA-4) so the
 * request budget is the caller's decision; this function never drops an asset
 * silently and never truncates a roster.
 */
export async function observeSafetyScoreV9DeploymentSupplyCensusGeneration(
  input: DeploymentSupplyCensusAssemblyInput,
  dependencyOverrides: DeploymentSupplyCensusAssemblyDependencies = {},
): Promise<SafetyScoreV9DeploymentSupplyCensusGeneration> {
  throwIfAborted(input.signal);
  const fixedInput = input.fixedInput;
  const observationClockSec = input.observationClockSec;
  if (!Number.isSafeInteger(observationClockSec) || observationClockSec < 0) {
    throw new Error("Deployment supply census observation clock must be a nonnegative integer");
  }
  const metaById = input.metaById ?? ACTIVE_META_BY_ID;
  const assetIds = [...new Set(input.assetIds)].sort(compareCodeUnits);
  if (assetIds.length > DEPLOYMENT_SUPPLY_CENSUS_MAX_ASSETS) {
    throw new Error(
      `Deployment supply census cohort exceeds ${DEPLOYMENT_SUPPLY_CENSUS_MAX_ASSETS} assets`,
    );
  }

  const accumulators = new Map<string, AssetCensusAccumulator>();
  let rosterDeployments = 0;
  for (const assetId of assetIds) {
    throwIfAborted(input.signal);
    const meta = metaById.get(assetId);
    const routes = meta?.bridgeRouteRisk?.routes ?? [];
    if (meta === undefined || routes.length === 0) continue;
    const aggregateSupplyUsd = getCirculatingRawOrNull(fixedInput.aggregateCirculatingById[assetId] ?? null);
    const roster = buildRoster(meta);
    const accumulator: AssetCensusAccumulator = {
      assetId,
      aggregateSupplyUsd,
      chainSupplyUsdByChainId: providerChainSupplyUsd(fixedInput.chainCirculatingById[assetId] ?? {}),
      referencePrice: assetReferencePrice(fixedInput, assetId),
      entries: roster.entries,
      rejected: roster.rejected,
      rows: new Map(),
    };
    accumulators.set(assetId, accumulator);
    if (routes.length > CENSUS_POLICY.maxDeploymentsPerAsset) {
      // Never truncate to 64: the asset cannot fill a partial packet.
      addRejection(accumulator.rejected, null, "deployment-over-cap");
      continue;
    }
    if (aggregateSupplyUsd === null || aggregateSupplyUsd <= 0) {
      // Without the audited aggregate there is no share denominator.
      addRejection(accumulator.rejected, null, "roster-incomplete");
      continue;
    }
    if (accumulator.rejected.size === 0) rosterDeployments += roster.entries.length;
  }
  if (rosterDeployments > DEPLOYMENT_SUPPLY_CENSUS_MAX_DEPLOYMENTS_PER_RUN) {
    throw new Error(
      `Deployment supply census run exceeds ${DEPLOYMENT_SUPPLY_CENSUS_MAX_DEPLOYMENTS_PER_RUN} deployments`,
    );
  }
  const readable = [...accumulators.values()].filter(accumulator =>
    accumulator.rejected.size === 0 && accumulator.entries.length > 0);

  let evmRequests = 0;
  const beforeRequest = (url: string): boolean => {
    if (input.beforeRequest !== undefined && !input.beforeRequest(url)) return false;
    if (evmRequests >= DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.maxEvmRequests) return false;
    evmRequests += 1;
    return true;
  };

  // Read targets, split by chain family. EVM is read per asset (its share
  // denominator and tier-0 bound are per asset); non-EVM readers batch a chain.
  const nonEvmTargetsByChainId = new Map<string, DeploymentSupplyCensusReadTarget[]>();
  for (const accumulator of readable) {
    for (const entry of accumulator.entries) {
      if (entry.readKind === "evm-total-supply") continue;
      let targets = nonEvmTargetsByChainId.get(entry.chainId);
      if (!targets) nonEvmTargetsByChainId.set(entry.chainId, targets = []);
      targets.push(entry.target);
    }
  }

  // Solana first: a finalized account snapshot cannot be rewound, while the
  // EVM and Move readers pin a historical block/ledger.
  const nonEvmChainIds = [...nonEvmTargetsByChainId.keys()].sort((left, right) =>
    left === "solana" ? -1 : right === "solana" ? 1 : compareCodeUnits(left, right));
  for (const chainId of nonEvmChainIds) {
    throwIfAborted(input.signal);
    const targets = nonEvmTargetsByChainId.get(chainId)!;
    let read: DeploymentSupplyCensusChainRead;
    try {
      read = await observeDeploymentSupplyCensusNonEvmChain({
        chainId,
        targets,
        scoringClockSec: observationClockSec,
        chainRpcs: input.chainRpcs,
        ...(input.dwellirNative === undefined ? {} : { dwellirNative: input.dwellirNative }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }, dependencyOverrides.nonEvm ?? {});
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      read = { kind: "rejected" as const, reason: "read-unavailable" as const };
    }
    for (const target of targets) {
      const accumulator = accumulators.get(target.assetId)!;
      if (read.kind === "rejected") {
        addRejection(accumulator.rejected, target.routeId, read.reason);
        continue;
      }
      const reason = read.rejected.get(target.routeId);
      if (reason !== undefined) {
        addRejection(accumulator.rejected, target.routeId, reason);
        continue;
      }
      const measurement = read.rows.get(target.routeId);
      if (measurement === undefined) {
        // An unattempted or timed-out chain is unavailable, never zero.
        addRejection(accumulator.rejected, target.routeId, "read-unavailable");
        continue;
      }
      const entry = accumulator.entries.find(candidate => candidate.routeId === target.routeId);
      if (entry === undefined || accumulator.aggregateSupplyUsd === null) continue;
      const priceIssue = priceRejection(observationClockSec, accumulator.referencePrice);
      if (priceIssue !== null || accumulator.referencePrice === null) {
        addRejection(accumulator.rejected, target.routeId, priceIssue ?? "reference-price-unavailable");
        continue;
      }
      const row = measuredRow(entry, measurement, accumulator.referencePrice, accumulator.aggregateSupplyUsd);
      if ("reason" in row) {
        addRejection(accumulator.rejected, target.routeId, row.reason);
        continue;
      }
      accumulator.rows.set(target.routeId, row);
    }
  }

  const evmChainIds = new Set<string>();
  const evmTargetsByAssetId = new Map<string, DeploymentSupplyCensusReadTarget[]>();
  for (const accumulator of readable) {
    // Legs are independent: a failed non-EVM read must not suppress the EVM
    // half. The packet is still rejected wholesale (a partial partition proves
    // nothing), but `rejected[]` names every failed leg instead of only the
    // first, and an EVM-only defect stays visible on assets that also carry a
    // Solana or Move route.
    const evmEntries = accumulator.entries.filter(entry => entry.readKind === "evm-total-supply");
    if (evmEntries.length === 0) continue;
    evmTargetsByAssetId.set(accumulator.assetId, evmEntries.map(entry => entry.target));
    for (const entry of evmEntries) evmChainIds.add(entry.chainId);
  }

  let pins: Map<string, DeploymentSupplyCensusEvmPinResolution> = new Map();
  if (evmChainIds.size > 0) {
    try {
      pins = await resolveDeploymentSupplyCensusEvmPins({
        chainIds: [...evmChainIds].sort(compareCodeUnits),
        scoringClockSec: observationClockSec,
        chainRpcs: input.chainRpcs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
        beforeRequest,
      }, dependencyOverrides.evm ?? {});
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      pins = new Map();
    }
  }

  for (const accumulator of readable) {
    throwIfAborted(input.signal);
    const evmTargets = evmTargetsByAssetId.get(accumulator.assetId);
    if (evmTargets === undefined) continue;
    let census: DeploymentSupplyCensusEvmCensus;
    try {
      census = await observeDeploymentSupplyCensusEvm({
        targets: evmTargets,
        scoringClockSec: observationClockSec,
        aggregateSupplyUsd: accumulator.aggregateSupplyUsd!,
        chainSupplyUsdByChainId: accumulator.chainSupplyUsdByChainId,
        referencePrices: new Map(evmTargets.map(target => [target.routeId, accumulator.referencePrice])),
        pins,
        chainRpcs: input.chainRpcs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
        beforeRequest,
      }, dependencyOverrides.evm ?? {});
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      census = { rows: [], rejected: evmTargets.map(target =>
        rejection(target.routeId, "read-unavailable")) };
    }
    for (const row of census.rows) accumulator.rows.set(row.routeId, row);
    for (const entry of census.rejected) {
      accumulator.rejected.set(rejectionKey(entry), entry);
    }
    for (const target of evmTargets) {
      if (!accumulator.rows.has(target.routeId) &&
        ![...accumulator.rejected.values()].some(row => row.routeId === target.routeId)) {
        addRejection(accumulator.rejected, target.routeId, "read-unavailable");
      }
    }
  }

  const censusById: SafetyScoreV9DeploymentSupplyCensusById = {};
  for (const assetId of [...accumulators.keys()].sort(compareCodeUnits)) {
    censusById[assetId] = assemblePacket(accumulators.get(assetId)!, observationClockSec);
  }

  return createSafetyScoreV9DeploymentSupplyCensusGeneration({
    schemaVersion: 1,
    kind: "safety-score-v9-deployment-supply-census-generation",
    sourceBaseInputGenerationId: fixedInput.baseInputGenerationId,
    registryFingerprint: fixedInput.registryFingerprint,
    capturedAtSec: observationClockSec,
    censusById,
  });
}

/**
 * The fixed-input projection capture writes at
 * `safetyScoreV9DeploymentSupplyCensusById` (PLAN §4.6 Interfaces). A missing
 * or absent generation is an empty map, never an empty census claim: callers
 * must publish `readSafetyScoreV9DeploymentSupplyCensus`'s `state`/`excluded`
 * beside it (SA-4), not read this as "no deployments".
 */
export function safetyScoreV9DeploymentSupplyCensusById(
  generation: Pick<SafetyScoreV9DeploymentSupplyCensusGeneration, "censusById"> | null | undefined,
): SafetyScoreV9DeploymentSupplyCensusById {
  return generation?.censusById ?? {};
}
