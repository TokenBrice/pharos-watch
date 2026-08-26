import type { StablecoinMeta } from "@shared/types";
import type { MintAuthorityClientSummary } from "@shared/types/stablecoin-client-meta";
import { resolveMechanismArchetype } from "@shared/lib/classification";
import { projectMintAuthorityClientSummary } from "@/lib/stablecoin-detail-mint-authority-client";
import {
  projectBlacklistabilityClientSummary,
  type BlacklistabilityClientSummary,
} from "@/lib/stablecoin-detail-blacklistability-client";
import {
  projectBridgeRouteRiskClientSummary,
  type BridgeRouteRiskClientSummary,
} from "@/lib/stablecoin-detail-bridge-client";
import {
  projectCustodyClientSummary,
  shouldDisplayCustodyModule,
  type CustodyClientSummary,
} from "@/lib/stablecoin-detail-custody-client";
import {
  projectOracleRiskClientSummary,
  type OracleRiskClientSummary,
} from "@/lib/stablecoin-detail-oracle-client";
import {
  projectReserveQualityClientSummary,
  type ReserveQualityClientSummary,
} from "@/lib/stablecoin-detail-reserve-quality-client";

type StablecoinDetailServerOnlyField =
  | "blacklistabilityReview"
  | "bridgeRouteRisk"
  | "custodyProfile"
  | "dependencyReview"
  | "implementationLaunchDate"
  | "mechanismArchetypeReview"
  | "mintAuthority"
  | "oracleRisk"
  | "reserveReview";

export type StablecoinDetailCoinMeta = Omit<StablecoinMeta, StablecoinDetailServerOnlyField> & {
  blacklistabilitySummary?: BlacklistabilityClientSummary | null;
  bridgeRouteRiskSummary?: BridgeRouteRiskClientSummary | null;
  custodyProfileSummary?: CustodyClientSummary | null;
  oracleRiskSummary?: OracleRiskClientSummary | null;
  reserveQualitySummary?: ReserveQualityClientSummary | null;
  mintAuthoritySummary?: MintAuthorityClientSummary | null;
  mintAuthorityParentSummaries?: Record<string, MintAuthorityClientSummary>;
};

interface BuildStablecoinDetailClientCoinOptions {
  parentById?: ReadonlyMap<string, StablecoinMeta>;
}

const EMPTY_ARCHETYPE_REGISTRY: ReadonlyMap<string, StablecoinMeta> = new Map();

function collectMintAuthorityParentSummaries(
  summary: MintAuthorityClientSummary | null,
  parentById: ReadonlyMap<string, StablecoinMeta> | undefined,
): Record<string, MintAuthorityClientSummary> | undefined {
  if (!summary?.inheritedFrom || !parentById) return undefined;

  const parents: Record<string, MintAuthorityClientSummary> = {};
  const seen = new Set<string>();
  let inheritedFrom: string | undefined = summary.inheritedFrom;

  while (inheritedFrom && !seen.has(inheritedFrom)) {
    seen.add(inheritedFrom);
    const parentCoin = parentById.get(inheritedFrom);
    if (!parentCoin) break;
    const parentSummary = projectMintAuthorityClientSummary(parentCoin);
    if (!parentSummary) break;
    parents[inheritedFrom] = parentSummary;
    inheritedFrom = parentSummary.inheritedFrom;
  }

  return Object.keys(parents).length > 0 ? parents : undefined;
}

export function buildStablecoinDetailClientCoin(
  coin: StablecoinMeta,
  options: BuildStablecoinDetailClientCoinOptions = {},
): StablecoinDetailCoinMeta {
  const {
    blacklistabilityReview: _serverOnlyBlacklistabilityReview,
    bridgeRouteRisk: _serverOnlyBridgeRouteRisk,
    custodyProfile: _serverOnlyCustodyProfile,
    dependencyReview: _serverOnlyDependencyReview,
    implementationLaunchDate: _serverOnlyImplementationLaunchDate,
    mechanismArchetypeReview: _serverOnlyMechanismArchetypeReview,
    mintAuthority: _serverOnlyMintAuthority,
    oracleRisk: _serverOnlyOracleRisk,
    reserveReview: _serverOnlyReserveReview,
    ...clientCoin
  } = coin;
  const mintAuthoritySummary = projectMintAuthorityClientSummary(coin);
  const mintAuthorityParentSummaries = collectMintAuthorityParentSummaries(mintAuthoritySummary, options.parentById);
  const bridgeRouteRiskSummary = projectBridgeRouteRiskClientSummary(coin);
  const resolvedArchetype = resolveMechanismArchetype(coin, options.parentById ?? EMPTY_ARCHETYPE_REGISTRY);
  const custodyProfileSummary = shouldDisplayCustodyModule(coin, resolvedArchetype)
    ? projectCustodyClientSummary(coin)
    : null;
  const oracleRiskSummary = projectOracleRiskClientSummary(coin);
  const reserveQualitySummary = projectReserveQualityClientSummary(coin);
  const blacklistabilitySummary = projectBlacklistabilityClientSummary(coin, options.parentById);
  return {
    ...clientCoin,
    ...(blacklistabilitySummary ? { blacklistabilitySummary } : {}),
    ...(bridgeRouteRiskSummary ? { bridgeRouteRiskSummary } : {}),
    ...(custodyProfileSummary ? { custodyProfileSummary } : {}),
    ...(oracleRiskSummary ? { oracleRiskSummary } : {}),
    ...(reserveQualitySummary ? { reserveQualitySummary } : {}),
    ...(mintAuthoritySummary ? { mintAuthoritySummary } : {}),
    ...(mintAuthorityParentSummaries ? { mintAuthorityParentSummaries } : {}),
  };
}
