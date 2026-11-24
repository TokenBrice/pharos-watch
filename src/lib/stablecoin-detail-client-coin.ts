import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { MintAuthorityClientSummary } from "@shared/types/stablecoin-client-meta";
import { resolveMechanismArchetype } from "@shared/lib/classification";
import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { getReserves } from "@shared/lib/reserve-templates";
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
import {
  projectReserveLookThroughClientSummary,
  type ReserveLookThroughClientSummary,
} from "@/lib/stablecoin-detail-reserve-look-through-client";
import {
  projectReserveAdmissionClientSummary,
  type ReserveAdmissionClientSummary,
} from "@/lib/stablecoin-detail-reserve-admission-client";

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
  reserveLookThrough?: ReserveLookThroughClientSummary | null;
  reserveAdmissionSummary?: ReserveAdmissionClientSummary | null;
  mintAuthoritySummary?: MintAuthorityClientSummary | null;
  /** True when the coin's live-reserve adapter enters the Telegram reserve-drift producer (`checkCollateralDrift`). */
  reserveDriftAlertEligible?: boolean;
};

/**
 * Matches `summarizeCollateralDriftFromLiveReserveMap` (`worker/src/lib/collateral-drift.ts`):
 * Telegram `reserve` alerts only fire for active coins with curated reserves and an unsuspended
 * `dynamic-mix` + `independent` live-reserve adapter.
 */
export function isReserveDriftAlertEligible(
  coin: Pick<StablecoinMeta, "liveReservesConfig" | "reserves">,
): boolean {
  const config = coin.liveReservesConfig;
  if (!config || config.suspended || !coin.reserves?.length) return false;
  const adapter = getLiveReserveAdapterDefinition(config.adapter);
  return adapter?.sourceModel === "dynamic-mix" && adapter.evidenceClass === "independent";
}

interface BuildStablecoinDetailClientCoinOptions {
  parentById?: ReadonlyMap<string, StablecoinMeta>;
}

const EMPTY_ARCHETYPE_REGISTRY: ReadonlyMap<string, StablecoinMeta> = new Map();

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
  const bridgeRouteRiskSummary = projectBridgeRouteRiskClientSummary(coin);
  const resolvedArchetype = resolveMechanismArchetype(coin, options.parentById ?? EMPTY_ARCHETYPE_REGISTRY);
  const custodyProfileSummary = shouldDisplayCustodyModule(coin, resolvedArchetype)
    ? projectCustodyClientSummary(coin)
    : null;
  const oracleRiskSummary = projectOracleRiskClientSummary(coin);
  const curatedReserves = coin.reserves?.length ? getReserves(coin) : null;
  const reserveQualitySummary = projectReserveQualityClientSummary(
    curatedReserves ? { ...coin, reserves: curatedReserves.reserves } : coin,
  );
  const reserveLookThrough = projectReserveLookThroughClientSummary(coin, options.parentById);
  const reserveAdmissionSummary = projectReserveAdmissionClientSummary(coin);
  const blacklistabilitySummary = projectBlacklistabilityClientSummary(coin, options.parentById);
  const reserveDriftAlertEligible = isReserveDriftAlertEligible(coin);
  return {
    ...clientCoin,
    ...(curatedReserves ? { reserves: curatedReserves.reserves } : {}),
    ...(blacklistabilitySummary ? { blacklistabilitySummary } : {}),
    ...(bridgeRouteRiskSummary ? { bridgeRouteRiskSummary } : {}),
    ...(custodyProfileSummary ? { custodyProfileSummary } : {}),
    ...(oracleRiskSummary ? { oracleRiskSummary } : {}),
    ...(reserveQualitySummary ? { reserveQualitySummary } : {}),
    ...(reserveLookThrough ? { reserveLookThrough } : {}),
    ...(reserveAdmissionSummary ? { reserveAdmissionSummary } : {}),
    ...(mintAuthoritySummary ? { mintAuthoritySummary } : {}),
    ...(reserveDriftAlertEligible ? { reserveDriftAlertEligible: true } : {}),
  };
}
