import { normalizeProtocol } from "./pool-helpers";

export type PoolIdentityConfidence = "exact" | "derived_unique" | "derived_ambiguous" | "none";
export type PoolIdentitySource = "address" | "native-id" | "token-shape-heuristic" | "none";

export interface PoolIdentity {
  exactPoolKey: string | null;
  derivedMatchKey: string | null;
  identitySource: PoolIdentitySource;
}

export interface KnownPoolIdentityIndex {
  exactKeys: Set<string>;
  derivedKeyCounts: Map<string, number>;
  derivedToExactKeys: Map<string, Set<string>>;
}

export function createKnownPoolIdentityIndex(): KnownPoolIdentityIndex {
  return {
    exactKeys: new Set<string>(),
    derivedKeyCounts: new Map<string, number>(),
    derivedToExactKeys: new Map<string, Set<string>>(),
  };
}

function normalizeTokenAddress(address: string): string {
  return address.trim().toLowerCase();
}

function isTrustworthyExactPoolId(poolId: string | null | undefined): boolean {
  if (!poolId) return false;
  const trimmed = poolId.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("orderbook-") || trimmed.startsWith("orderbook:")) return true;
  if (/^0x[a-f0-9]{40}$/i.test(trimmed)) return true;
  return /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(trimmed);
}

function resolvePoolShapeFamily(poolType?: string | null): string {
  const normalized = (poolType ?? "").toLowerCase();
  if (!normalized) return "generic";
  if (normalized.includes("orderbook")) return "orderbook";
  if (normalized.includes("weighted")) return "weighted";
  if (normalized.includes("clmm") || normalized.includes("whirlpool") || normalized.includes("concentrated")) {
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
}): PoolIdentity {
  const chain = input.chain.toLowerCase();
  const exactPoolId = input.poolAddressOrId?.trim() ?? "";
  const exactPoolKey = isTrustworthyExactPoolId(exactPoolId)
    ? `${chain}:${exactPoolId.toLowerCase()}`
    : null;

  const normalizedTokens = input.tokenAddresses
    .map((token) => normalizeTokenAddress(token))
    .filter(Boolean)
    .sort();

  const derivedMatchKey = normalizedTokens.length >= 2
    ? [
        chain,
        normalizeProtocol(input.protocol),
        normalizedTokens.join(":"),
        resolvePoolShapeFamily(input.poolType),
        resolveFeeTierBucket(input.feeTierBps),
        input.isStable == null ? "na" : input.isStable ? "stable" : "volatile",
      ].join("|")
    : null;

  return {
    exactPoolKey,
    derivedMatchKey,
    identitySource: exactPoolKey
      ? exactPoolId.startsWith("orderbook") ? "native-id" : "address"
      : derivedMatchKey
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

export function registerKnownPoolIdentity(
  known: KnownPoolIdentityIndex,
  identity: PoolIdentity,
): void {
  if (identity.exactPoolKey) {
    known.exactKeys.add(identity.exactPoolKey);
  }
  if (!identity.derivedMatchKey) return;
  known.derivedKeyCounts.set(
    identity.derivedMatchKey,
    (known.derivedKeyCounts.get(identity.derivedMatchKey) ?? 0) + 1,
  );
  if (identity.exactPoolKey) {
    const existing = known.derivedToExactKeys.get(identity.derivedMatchKey) ?? new Set<string>();
    existing.add(identity.exactPoolKey);
    known.derivedToExactKeys.set(identity.derivedMatchKey, existing);
  }
}

export function countDerivedMatchKeys(identities: PoolIdentity[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const identity of identities) {
    if (!identity.derivedMatchKey) continue;
    counts.set(identity.derivedMatchKey, (counts.get(identity.derivedMatchKey) ?? 0) + 1);
  }
  return counts;
}

export function getIdentityDedupReason(
  identity: PoolIdentity,
  known: KnownPoolIdentityIndex,
  incomingDerivedCount: number,
): "exact" | "derived_unique" | null {
  if (identity.exactPoolKey && known.exactKeys.has(identity.exactPoolKey)) {
    return "exact";
  }
  if (!identity.derivedMatchKey || incomingDerivedCount !== 1) return null;

  const knownCount = known.derivedKeyCounts.get(identity.derivedMatchKey) ?? 0;
  if (knownCount !== 1) return null;

  const knownExactCount = known.derivedToExactKeys.get(identity.derivedMatchKey)?.size ?? 0;
  if (identity.exactPoolKey && knownExactCount > 0) {
    return null;
  }

  return "derived_unique";
}
