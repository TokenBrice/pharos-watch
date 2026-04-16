import { normalizeProtocol } from "./pool-helpers";

export type PoolIdentityConfidence = "exact" | "derived_unique" | "derived_ambiguous" | "none";
export type PoolIdentitySource = "address" | "native-id" | "token-shape-heuristic" | "none";
export type PoolDedupReason = "exact" | "derived_unique" | "derived_optional_wildcard";

export interface PoolIdentity {
  exactPoolKey: string | null;
  derivedMatchKey: string | null;
  optionalWildcardKey: string | null;
  hasMissingOptionalIdentityFields: boolean;
  identitySource: PoolIdentitySource;
}

export interface KnownPoolIdentityIndex {
  exactKeys: Set<string>;
  derivedKeyCounts: Map<string, number>;
  derivedToExactKeys: Map<string, Set<string>>;
  wildcardKeyCounts: Map<string, number>;
  wildcardToExactKeys: Map<string, Set<string>>;
}

export function createKnownPoolIdentityIndex(): KnownPoolIdentityIndex {
  return {
    exactKeys: new Set<string>(),
    derivedKeyCounts: new Map<string, number>(),
    derivedToExactKeys: new Map<string, Set<string>>(),
    wildcardKeyCounts: new Map<string, number>(),
    wildcardToExactKeys: new Map<string, Set<string>>(),
  };
}

function normalizeTokenAddress(address: string): string {
  return (address ?? "").trim().toLowerCase();
}

function isUniswapV4PoolId(poolId: string, protocol?: string | null): boolean {
  return normalizeProtocol(protocol ?? "") === "uniswap-v4" && /^0x[a-f0-9]{64}$/i.test(poolId);
}

export function isTrustworthyExactPoolId(poolId: string | null | undefined, protocol?: string | null): boolean {
  if (!poolId) return false;
  const trimmed = poolId.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("orderbook-") || trimmed.startsWith("orderbook:")) return true;
  if (/^0x[a-f0-9]{40}$/i.test(trimmed)) return true;
  if (isUniswapV4PoolId(trimmed, protocol)) return true;
  return /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(trimmed);
}

function resolvePoolShapeFamily(poolType?: string | null, protocol?: string | null, isStable?: boolean | null): string {
  const normalized = (poolType ?? "").toLowerCase();
  const normalizedProtocol = normalizeProtocol(protocol ?? "");
  if (normalizedProtocol === "uniswap-v3" || normalizedProtocol === "uniswap-v4") {
    return "concentrated";
  }
  if (!normalized) return "generic";
  if (normalized.includes("orderbook")) return "orderbook";
  if (normalized.includes("weighted")) {
    // DL Balancer V3 rows often omit the stable subtype in `project`, so the
    // stablecoin flag is the only clue that the pool should align with the
    // direct Balancer stable pool identity rather than a weighted fallback.
    if (normalizeProtocol(protocol ?? "") === "balancer" && isStable === true) {
      return "stable";
    }
    return "weighted";
  }
  if (normalized.includes("clmm") || normalized.includes("whirlpool") || normalized.includes("concentrated")) {
    return "concentrated";
  }
  if (
    normalized.includes("cg-cl") ||
    normalized.includes("ds-concentrated") ||
    normalized.includes("gt-concentrated") ||
    normalized.includes("v3") ||
    normalized.includes("v4")
  ) {
    return "concentrated";
  }
  if (
    normalized.includes("stable") ||
    normalized.includes("stableswap") ||
    normalized.includes("curve-stableswap") ||
    normalized.includes("fluid-dex")
  ) {
    return "stable";
  }
  return "generic";
}

function resolveFeeTierBucket(feeTierBps?: number | null): string {
  if (feeTierBps == null || !Number.isFinite(feeTierBps) || feeTierBps <= 0) return "na";
  if (feeTierBps <= 1) return "1";
  if (feeTierBps <= 5) return "5";
  if (feeTierBps <= 30) return "30";
  if (feeTierBps <= 100) return "100";
  return "wide";
}

export function buildPoolIdentity(input: {
  chain: string;
  protocol: string;
  poolAddressOrId?: string | null;
  tokenAddresses: string[];
  poolType?: string | null;
  feeTierBps?: number | null;
  isStable?: boolean | null;
  isStableHint?: boolean;
}): PoolIdentity {
  const chain = input.chain.toLowerCase();
  const exactPoolId = input.poolAddressOrId?.trim() ?? "";
  const exactPoolKey = isTrustworthyExactPoolId(exactPoolId, input.protocol)
    ? `${chain}:${exactPoolId.toLowerCase()}`
    : null;

  const effectiveIsStable: boolean | null =
    input.isStable === true || (input.isStable == null && input.isStableHint === true)
      ? true
      : input.isStable ?? null;

  const normalizedTokens = input.tokenAddresses
    .map((token) => normalizeTokenAddress(token))
    .filter(Boolean)
    .sort();
  const poolShapeFamily = resolvePoolShapeFamily(input.poolType, input.protocol, effectiveIsStable);
  const feeTierBucket = resolveFeeTierBucket(input.feeTierBps);
  const stabilityBucket = effectiveIsStable == null ? "na" : effectiveIsStable ? "stable" : "volatile";
  const hasMissingOptionalIdentityFields = feeTierBucket === "na" || effectiveIsStable == null;

  const derivedMatchKey =
    normalizedTokens.length >= 2
      ? [
          chain,
          normalizeProtocol(input.protocol),
          normalizedTokens.join(":"),
          poolShapeFamily,
          feeTierBucket,
          stabilityBucket,
        ].join("|")
      : null;
  const optionalWildcardKey =
    normalizedTokens.length >= 2
      ? [chain, normalizeProtocol(input.protocol), normalizedTokens.join(":"), poolShapeFamily].join("|")
      : null;

  return {
    exactPoolKey,
    derivedMatchKey,
    optionalWildcardKey,
    hasMissingOptionalIdentityFields,
    identitySource: exactPoolKey
      ? exactPoolId.startsWith("orderbook") || isUniswapV4PoolId(exactPoolId, input.protocol)
        ? "native-id"
        : "address"
      : derivedMatchKey || optionalWildcardKey
        ? "token-shape-heuristic"
        : "none",
  };
}

export function buildKnownPoolIdentityIndex(identities: PoolIdentity[]): KnownPoolIdentityIndex {
  const known = createKnownPoolIdentityIndex();

  for (const identity of identities) {
    registerKnownPoolIdentity(known, identity);
  }

  return known;
}

export function registerKnownPoolIdentity(known: KnownPoolIdentityIndex, identity: PoolIdentity): void {
  if (identity.exactPoolKey) {
    known.exactKeys.add(identity.exactPoolKey);
  }
  if (!identity.derivedMatchKey) return;
  known.derivedKeyCounts.set(identity.derivedMatchKey, (known.derivedKeyCounts.get(identity.derivedMatchKey) ?? 0) + 1);
  if (identity.exactPoolKey) {
    const existing = known.derivedToExactKeys.get(identity.derivedMatchKey) ?? new Set<string>();
    existing.add(identity.exactPoolKey);
    known.derivedToExactKeys.set(identity.derivedMatchKey, existing);
  }
  if (!identity.optionalWildcardKey) return;
  known.wildcardKeyCounts.set(
    identity.optionalWildcardKey,
    (known.wildcardKeyCounts.get(identity.optionalWildcardKey) ?? 0) + 1,
  );
  if (identity.exactPoolKey) {
    const existing = known.wildcardToExactKeys.get(identity.optionalWildcardKey) ?? new Set<string>();
    existing.add(identity.exactPoolKey);
    known.wildcardToExactKeys.set(identity.optionalWildcardKey, existing);
  }
}

export function countPoolIdentityKeys(identities: PoolIdentity[]): {
  derived: Map<string, number>;
  wildcard: Map<string, number>;
} {
  const derived = new Map<string, number>();
  const wildcard = new Map<string, number>();
  for (const identity of identities) {
    if (identity.derivedMatchKey) {
      derived.set(identity.derivedMatchKey, (derived.get(identity.derivedMatchKey) ?? 0) + 1);
    }
    if (identity.optionalWildcardKey) {
      wildcard.set(identity.optionalWildcardKey, (wildcard.get(identity.optionalWildcardKey) ?? 0) + 1);
    }
  }
  return { derived, wildcard };
}

export function getIdentityDedupReason(
  identity: PoolIdentity,
  known: KnownPoolIdentityIndex,
  incomingCounts: { derived: number; wildcard: number },
  options?: { allowOptionalWildcard?: boolean },
): PoolDedupReason | null {
  if (identity.exactPoolKey && known.exactKeys.has(identity.exactPoolKey)) {
    return "exact";
  }
  if (identity.derivedMatchKey && incomingCounts.derived === 1) {
    // Primary derived-unique match.
    const knownCount = known.derivedKeyCounts.get(identity.derivedMatchKey) ?? 0;
    if (knownCount === 1) {
      const knownExactCount = known.derivedToExactKeys.get(identity.derivedMatchKey)?.size ?? 0;
      if (!(identity.exactPoolKey && knownExactCount > 0)) {
        return "derived_unique";
      }
    }

    // Secondary: try matching with fee bucket coerced to "na" (or from "na" to
    // a concrete bucket). DL rows often lack feeTierBps, producing feeBucket="na",
    // while direct-API rows have a concrete bucket. Without this, the primary
    // derived-unique check never matches across sources.
    // Format: chain|protocol|tokens|shape|feeBucket|stability
    const parts = identity.derivedMatchKey.split("|");
    if (parts.length === 6 && parts[4] !== "na") {
      // Incoming has concrete fee; try matching known rows with fee=na.
      const naVariant = [...parts.slice(0, 4), "na", parts[5]].join("|");
      const knownNaCount = known.derivedKeyCounts.get(naVariant) ?? 0;
      if (knownNaCount === 1) {
        const knownExactCount = known.derivedToExactKeys.get(naVariant)?.size ?? 0;
        if (!(identity.exactPoolKey && knownExactCount > 0)) {
          return "derived_unique";
        }
      }
    }
    if (parts.length === 6 && parts[4] === "na") {
      // Incoming has fee=na; scan known derived keys for a matching concrete-fee
      // variant. Only match if exactly one candidate exists (otherwise ambiguous).
      const prefix = parts.slice(0, 4).join("|");
      const suffix = parts[5];
      let matchKey: string | null = null;
      let matchCount = 0;
      for (const [knownKey, knownCount] of known.derivedKeyCounts) {
        if (knownCount !== 1) continue;
        const knownParts = knownKey.split("|");
        if (knownParts.length !== 6) continue;
        if (knownParts[4] === "na") continue;
        if (knownParts[5] !== suffix) continue;
        if (knownParts.slice(0, 4).join("|") !== prefix) continue;
        matchKey = knownKey;
        matchCount++;
        if (matchCount > 1) break;
      }
      if (matchCount === 1 && matchKey) {
        const knownExactCount = known.derivedToExactKeys.get(matchKey)?.size ?? 0;
        if (!(identity.exactPoolKey && knownExactCount > 0)) {
          return "derived_unique";
        }
      }
    }
  }

  if (!options?.allowOptionalWildcard) return null;
  if (!identity.optionalWildcardKey || !identity.hasMissingOptionalIdentityFields || incomingCounts.wildcard !== 1) {
    return null;
  }

  const knownWildcardCount = known.wildcardKeyCounts.get(identity.optionalWildcardKey) ?? 0;
  if (knownWildcardCount !== 1) return null;

  const knownExactCount = known.wildcardToExactKeys.get(identity.optionalWildcardKey)?.size ?? 0;
  if (identity.exactPoolKey && knownExactCount > 0) {
    return null;
  }

  return "derived_optional_wildcard";
}
