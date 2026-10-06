import workerRuntimeAsset from "../../data/stablecoins/coins.worker-runtime.generated.json";
import type { ContractDeployment, PegCurrency, StablecoinMeta } from "../../types/core";
import type { StablecoinStatus } from "../../types/stablecoin-taxonomy";
import { buildStablecoinRegistryIndexes } from "./registry-indexes";
import {
  isActiveStablecoinMeta,
  isDelistedStablecoinMeta,
  isFrozenStablecoinMeta,
  isPreLaunchStablecoinMeta,
  isQuarantinedStablecoinMeta,
  isReadableStablecoinMeta,
} from "./status";


export interface WorkerRuntimeStablecoinMeta {
  id: string;
  symbol: string;
  name: string;
  geckoId?: string;
  pegCurrency: PegCurrency;
  governance: string;
  navToken?: boolean;
  commodityOunces?: number;
  status?: StablecoinStatus;
  contracts?: ContractDeployment[];
  tradedContracts?: ContractDeployment[];
  liveReserveCircuitSource?: string;
  liveReservesConfig?: StablecoinMeta["liveReservesConfig"];
  reserveReview?: StablecoinMeta["reserveReview"];
  variantOf?: StablecoinMeta["variantOf"];
  pegReferenceId?: StablecoinMeta["pegReferenceId"];
  protocolSlug?: StablecoinMeta["protocolSlug"];
  launchDate?: StablecoinMeta["launchDate"];
  pegScoreCoverage?: Pick<NonNullable<StablecoinMeta["pegScoreCoverage"]>, "startDate">;
  proofOfReserves?: Pick<NonNullable<StablecoinMeta["proofOfReserves"]>, "url" | "provider">;
  links?: Pick<NonNullable<StablecoinMeta["links"]>[number], "label" | "url">[];
  // DDR consumes these small structural/lifecycle slices, not issuer evidence.
  flags: Pick<StablecoinMeta["flags"], "pegCurrency" | "governance" | "navToken">
    & Partial<StablecoinMeta["flags"]>;
  mechanismArchetype?: StablecoinMeta["mechanismArchetype"];
  windDownAnnouncedAt?: string;
  collateralQuality?: StablecoinMeta["collateralQuality"];
  custodyModel?: StablecoinMeta["custodyModel"];
  mintAuthority?: Pick<NonNullable<StablecoinMeta["mintAuthority"]>, "mintPath" | "authorityPosture"> & {
    mintIncidents?: Pick<NonNullable<NonNullable<StablecoinMeta["mintAuthority"]>["mintIncidents"]>[number],
      "date" | "status" | "resolvedAt">[];
  };
  reserves?: Pick<NonNullable<StablecoinMeta["reserves"]>[number], "risk" | "pct" | "coinId">[]
    | StablecoinMeta["reserves"];
  blacklistabilityReview?: Pick<NonNullable<StablecoinMeta["blacklistabilityReview"]>, "reviewedStatus">;
  dependencies?: Pick<NonNullable<StablecoinMeta["dependencies"]>[number], "id" | "weight">[];
  frozenAt?: string;
  obituary?: Pick<NonNullable<StablecoinMeta["obituary"]>, "deathDate">;
}

/** Configured feeds retain the complete adapter input slice in the projection. */
export type WorkerLiveReserveStablecoinMeta = Omit<WorkerRuntimeStablecoinMeta, "flags" | "reserves" | "liveReservesConfig">
  & Pick<StablecoinMeta, "flags" | "reserves">
  & { liveReservesConfig: NonNullable<StablecoinMeta["liveReservesConfig"]> };

export function hasWorkerLiveReserves(
  coin: WorkerRuntimeStablecoinMeta,
): coin is WorkerLiveReserveStablecoinMeta {
  return coin.liveReservesConfig != null;
}

const registry = buildStablecoinRegistryIndexes(workerRuntimeAsset as WorkerRuntimeStablecoinMeta[], {
  isActive: isActiveStablecoinMeta,
  lifecyclePredicates: {
    preLaunch: isPreLaunchStablecoinMeta,
    frozen: isFrozenStablecoinMeta,
    quarantined: isQuarantinedStablecoinMeta,
    delisted: isDelistedStablecoinMeta,
    readable: isReadableStablecoinMeta,
  },
});

export const WORKER_TRACKED_STABLECOINS = registry.tracked.stablecoins as WorkerRuntimeStablecoinMeta[];

export const WORKER_TRACKED_META_BY_ID: ReadonlyMap<string, WorkerRuntimeStablecoinMeta> = registry.tracked.metaById;

export const WORKER_ACTIVE_STABLECOINS: readonly WorkerRuntimeStablecoinMeta[] = registry.active.stablecoins;

export const WORKER_ACTIVE_IDS: ReadonlySet<string> = registry.active.ids;

export const WORKER_ACTIVE_META_BY_ID: ReadonlyMap<string, WorkerRuntimeStablecoinMeta> = registry.active.metaById;

export const WORKER_PRE_LAUNCH_STABLECOINS: readonly WorkerRuntimeStablecoinMeta[] =
  registry.lifecycle.preLaunch.stablecoins;

export const WORKER_FROZEN_IDS: ReadonlySet<string> = registry.lifecycle.frozen.ids;

export const WORKER_READABLE_IDS: ReadonlySet<string> = registry.lifecycle.readable.ids;

export const WORKER_ACTIVE_LIVE_RESERVE_CIRCUIT_SOURCES: readonly string[] = [
  ...new Set(
    WORKER_ACTIVE_STABLECOINS
      .map((stablecoin) => stablecoin.liveReserveCircuitSource)
      .filter((source): source is string => source != null),
  ),
];
