import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { buildReviewedDeploymentRouteInventory, expectedWmDeploymentIdentity, type ReviewedDeploymentSupplyObservation, type WmDeploymentIdentity } from "../lib/safety-score-v9/supply-attribution-contract";
import {
  buildXautTransparencySource,
  XAUT0_ADAPTER_ADDRESS, XAUT0_ADAPTER_IMPLEMENTATION_ADDRESS,
  XAUT0_ADAPTER_IMPLEMENTATION_CODE_SHA256, XAUT0_ADAPTER_RUNTIME_CODE_SHA256,
  XAUT0_LAYERZERO_ENDPOINT_ADDRESS, XAUT_CANONICAL_IMPLEMENTATION_ADDRESS,
  XAUT_CANONICAL_IMPLEMENTATION_CODE_SHA256, XAUT_CANONICAL_RUNTIME_CODE_SHA256,
  XAUT_CANONICAL_TOKEN_ADDRESS, XAUT_TRANSPARENCY_SOURCE_ID, XAUT_TREASURY_ADDRESS,
  type XautLockMintObservation,
} from "../lib/safety-score-v9/xaut-supply-attribution-contract";

/** Shared timeout for the V9 evaluation suites; a full candidate build is slow. */
export const V9_EVALUATION_TEST_TIMEOUT_MS = 30_000;

/**
 * Synthetic epoch used by the general-purpose V9 fixtures. It is deliberately
 * far below any real reviewed-registry date, so it never needs re-pinning; the
 * suites that must sit *after* the newest registry review use
 * `v9TestClockSec()` instead.
 */
export const V9_FIXTURE_CLOCK_SEC = 10_000;
export const V9_FIXTURE_OBSERVED_AT_SEC = V9_FIXTURE_CLOCK_SEC - 100;

const DAY_SEC = 86_400;

type XautObservationPatch = Partial<Omit<XautLockMintObservation, "disclosure">> & {
  disclosure?: Partial<XautLockMintObservation["disclosure"]>;
};

export interface XautObservationOptions extends XautObservationPatch {
  clockSec?: number;
}

/** Canonical production-shaped XAUT observation with an explicitly controlled clock. */
export function makeXautObservation(options: XautObservationOptions = {}): XautLockMintObservation {
  const clockSec = options.clockSec ?? V9_FIXTURE_CLOCK_SEC;
  const observation: XautLockMintObservation = {
    chainId: "ethereum",
    canonicalTokenAddress: XAUT_CANONICAL_TOKEN_ADDRESS,
    adapterAddress: XAUT0_ADAPTER_ADDRESS,
    decimals: 6,
    canonicalTotalSupplyRaw: "707747089000",
    treasuryAddress: XAUT_TREASURY_ADDRESS,
    treasuryBalanceRaw: "94923429468",
    adapterLockedSupplyRaw: "29720802896",
    blockNumber: 25_601_844,
    blockTimeSec: clockSec - 100,
    blockHash: `0x${"ab".repeat(32)}`,
    canonicalRuntimeCodeSha256: XAUT_CANONICAL_RUNTIME_CODE_SHA256,
    canonicalImplementationAddress: XAUT_CANONICAL_IMPLEMENTATION_ADDRESS,
    canonicalImplementationCodeSha256: XAUT_CANONICAL_IMPLEMENTATION_CODE_SHA256,
    adapterRuntimeCodeSha256: XAUT0_ADAPTER_RUNTIME_CODE_SHA256,
    adapterImplementationAddress: XAUT0_ADAPTER_IMPLEMENTATION_ADDRESS,
    adapterImplementationCodeSha256: XAUT0_ADAPTER_IMPLEMENTATION_CODE_SHA256,
    adapterTokenAddress: XAUT_CANONICAL_TOKEN_ADDRESS,
    adapterEndpointAddress: XAUT0_LAYERZERO_ENDPOINT_ADDRESS,
    disclosure: {
      sourceId: XAUT_TRANSPARENCY_SOURCE_ID,
      sourceConfigDigest: buildXautTransparencySource()!.configDigest,
      sourceTimestampSec: clockSec - 200,
      responseSha256: "c".repeat(64),
      totalAuthorizedRaw: "707747089000",
      notIssuedRaw: "94923429468",
      quarantinedRaw: "0",
    },
  };
  const { clockSec: _clockSec, disclosure, ...patch } = options;
  return {
    ...observation,
    ...patch,
    disclosure: { ...observation.disclosure, ...disclosure },
  };
}

export function patchXautObservation(
  observation: XautLockMintObservation,
  patch: XautObservationPatch,
): XautLockMintObservation {
  return {
    ...observation,
    ...patch,
    disclosure: { ...observation.disclosure, ...patch.disclosure },
  };
}

export function corruptXautObservation(
  observation: XautLockMintObservation,
  field: keyof XautLockMintObservation | `disclosure.${keyof XautLockMintObservation["disclosure"]}`,
  value: unknown,
): XautLockMintObservation {
  if (field.startsWith("disclosure.")) {
    const disclosureField = field.slice("disclosure.".length) as keyof XautLockMintObservation["disclosure"];
    return patchXautObservation(observation, {
      disclosure: { [disclosureField]: value } as Partial<XautLockMintObservation["disclosure"]>,
    });
  }
  return { ...observation, [field]: value } as XautLockMintObservation;
}

export interface WmDeploymentObservationOptions {
  clockSec?: number;
  rawSupplyByRoute?: Readonly<Record<string, string>>;
  blockTimeByChain?: Readonly<Record<string, number>>;
}

type KeysOfUnion<T> = T extends T ? keyof T : never;

type WmDeploymentIdentityFields = Pick<
  ReviewedDeploymentSupplyObservation,
  | "blockHash"
  | "runtimeCodeSha256"
  | "implementationAddress"
  | "implementationCodeSha256"
  | "underlyingTokenAddress"
  | "controllerAddress"
  | "programOwner"
  | "mintAuthority"
  | "controllerProgramOwner"
>;

function wmDeploymentIdentityFields(
  identity: WmDeploymentIdentity,
  index: number,
): WmDeploymentIdentityFields {
  if (identity.runtime === "evm") {
    return {
      blockHash: `0x${(index + 1).toString(16).repeat(64)}`,
      runtimeCodeSha256: identity.runtimeCodeSha256,
      implementationAddress: identity.implementationAddress,
      implementationCodeSha256: identity.implementationCodeSha256,
      underlyingTokenAddress: identity.underlyingTokenAddress,
      controllerAddress: identity.controllerAddress,
    };
  }
  return {
    blockHash: "B".repeat(44),
    programOwner: identity.programOwner,
    mintAuthority: identity.mintAuthority,
    controllerAddress: identity.controllerAddress,
    controllerProgramOwner: identity.controllerProgramOwner,
  };
}

const DEFAULT_WM_RAW_SUPPLY_BY_ROUTE: Readonly<Record<string, string>> = {
  "ethereum:0x437cc33344a0b27a429f795ff6b469c72698b291": "86712798085682",
  "arbitrum:0x437cc33344a0b27a429f795ff6b469c72698b291": "88459935972",
  "base:0x437cc33344a0b27a429f795ff6b469c72698b291": "70802728527",
  "plume:0x437cc33344a0b27a429f795ff6b469c72698b291": "0",
  "solana:mzeroXDoBpRVhnEXBra27qzAMdxgpWVY3DzQW7xMVJp": "247794997129",
};

const DEFAULT_WM_BLOCK_OFFSET_BY_CHAIN: Readonly<Record<string, number>> = {
  ethereum: -21,
  arbitrum: -14,
  base: -13,
  plume: -12,
  solana: -25,
};

export function makeWmDeploymentObservations(
  options: WmDeploymentObservationOptions = {},
): ReviewedDeploymentSupplyObservation[] {
  const clockSec = options.clockSec ?? V9_FIXTURE_CLOCK_SEC;
  const inventory = buildReviewedDeploymentRouteInventory("wm-m0");
  if (!inventory) throw new Error("Missing wM route inventory");
  return inventory.routes.map((route, index) => {
    const identity = expectedWmDeploymentIdentity(route.routeId);
    const rawSupply = options.rawSupplyByRoute?.[route.routeId] ?? DEFAULT_WM_RAW_SUPPLY_BY_ROUTE[route.routeId];
    const blockTimeSec = options.blockTimeByChain?.[route.chainId]
      ?? clockSec + (DEFAULT_WM_BLOCK_OFFSET_BY_CHAIN[route.chainId] ?? -10);
    if (!identity || rawSupply === undefined) throw new Error(`Missing wM fixture row for ${route.routeId}`);
    const common = {
      routeId: route.routeId,
      chainId: route.chainId,
      contractAddress: route.contractAddress,
      decimals: route.decimals,
      rawSupply,
      blockNumberOrSlot: (25_000_000 + index).toString(),
      blockTimeSec,
    };
    return { ...common, ...wmDeploymentIdentityFields(identity, index) };
  });
}

export function corruptWmDeploymentObservation(
  observations: readonly ReviewedDeploymentSupplyObservation[],
  predicate: (observation: ReviewedDeploymentSupplyObservation, index: number) => boolean,
  field: KeysOfUnion<ReviewedDeploymentSupplyObservation>,
  value: unknown,
): ReviewedDeploymentSupplyObservation[] {
  return observations.map((observation, index) =>
    predicate(observation, index)
      ? { ...observation, [field]: value } as ReviewedDeploymentSupplyObservation
      : observation,
  );
}

/**
 * The derived clock at the time this helper was written (2026-08-10T00:00:00Z:
 * the 2026-08-09 xaut-tether mechanism-archetype review plus one day). Reviews
 * only ever move forward, so a derived clock below this floor means the coin
 * registry lost review dates — fail loudly instead of silently relaxing the
 * freshness gates every V9 suite depends on.
 */
const V9_TEST_CLOCK_FLOOR_SEC = 1_786_320_000;

const REVIEW_DATE_KEYS = new Set(["reviewedAt", "compositionAsOf"]);

function collectReviewDateSecs(value: unknown, into: number[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectReviewDateSecs(entry, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (REVIEW_DATE_KEYS.has(key) && typeof child === "string") {
      const parsed = Date.parse(child);
      if (Number.isFinite(parsed)) into.push(Math.floor(parsed / 1_000));
    }
    collectReviewDateSecs(child, into);
  }
}

/** Latest `reviewedAt` / `compositionAsOf` second recorded on one coin's registry entry. */
export function v9CoinMaxReviewedAtSec(coinId: string): number {
  const coin = ACTIVE_STABLECOINS.find((entry) => entry.id === coinId);
  if (coin === undefined) throw new Error(`v9CoinMaxReviewedAtSec: ${coinId} is not an active stablecoin`);
  const seconds: number[] = [];
  collectReviewDateSecs(coin, seconds);
  if (seconds.length === 0) throw new Error(`v9CoinMaxReviewedAtSec: ${coinId} has no review dates`);
  return Math.max(...seconds);
}

let cachedRegistryReviewMaxSec: number | null = null;

/**
 * A scoring clock that always sits one day past the newest reviewed date in the
 * tracked coin registry. Replaces the hand-pinned absolute clocks that had to be
 * bumped every time a curation pass moved a review forward — the V9 producer
 * rejects a `reviewedAt` later than the scoring clock, so those literals went
 * stale on every authoring pass.
 */
export function v9TestClockSec(): number {
  if (cachedRegistryReviewMaxSec === null) {
    const seconds: number[] = [];
    collectReviewDateSecs(ACTIVE_STABLECOINS, seconds);
    if (seconds.length === 0) {
      throw new Error("v9TestClockSec: no reviewedAt/compositionAsOf dates found in the coin registry");
    }
    cachedRegistryReviewMaxSec = Math.max(...seconds);
  }
  const clockSec = cachedRegistryReviewMaxSec + DAY_SEC;
  if (clockSec < V9_TEST_CLOCK_FLOOR_SEC) {
    throw new Error(
      `v9TestClockSec: derived clock ${clockSec} went backwards past the ${V9_TEST_CLOCK_FLOOR_SEC} floor`,
    );
  }
  return clockSec;
}

// --------------------------------------------------------------------------
// Fact-status fixtures
// --------------------------------------------------------------------------
