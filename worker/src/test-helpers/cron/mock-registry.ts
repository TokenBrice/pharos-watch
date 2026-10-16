import { buildStablecoinRegistryIndexes } from "@shared/lib/stablecoins/registry-indexes";
import type * as StablecoinRegistry from "@shared/lib/stablecoins/registry";

/**
 * Factory for stubbing `@shared/lib/stablecoins/registry` in cron tests.
 *
 * Captures the common shape used by `sync-yield-data-*.test.ts`,
 * `sync-stablecoins.test.ts`, and `enrich-prices-*.test.ts`: derive `*_IDS` and
 * `*_META_BY_ID` from a supplied stablecoin list, with empty FROZEN defaults.
 *
 * Callers pass a minimal stablecoin array; the factory returns the full
 * registry export surface those tests consume.
 */

export interface MockRegistryStablecoin {
  id: string;
  name?: string;
  symbol?: string;
  geckoId?: string | null;
  llamaId?: string;
  detailProvider?: string;
  contracts?: Array<{ chain: string; address: string; decimals: number }>;
  flags?: Record<string, unknown>;
  yieldConfig?: Record<string, unknown>;
  commodityOunces?: number;
  protocolSlug?: string;
  [key: string]: unknown;
}

export interface MockRegistryOptions {
  /** The active stablecoin list. READABLE_* also includes supplied frozen assets. */
  stablecoins: MockRegistryStablecoin[];
  /** Optional override for the tracked-meta map; defaults to active map. */
  trackedMetaById?: Map<string, unknown>;
  /** Optional frozen stablecoin list. Empty by default. */
  frozenStablecoins?: MockRegistryStablecoin[];
}

export interface MockRegistryExports {
  TRACKED_STABLECOINS: MockRegistryStablecoin[];
  TRACKED_IDS: Set<string>;
  ACTIVE_STABLECOINS: MockRegistryStablecoin[];
  ACTIVE_IDS: Set<string>;
  ACTIVE_META_BY_ID: Map<string, MockRegistryStablecoin>;
  TRACKED_META_BY_ID: Map<string, unknown>;
  FROZEN_STABLECOINS: MockRegistryStablecoin[];
  FROZEN_IDS: Set<string>;
  FROZEN_META_BY_ID: Map<string, MockRegistryStablecoin>;
  READABLE_STABLECOINS: MockRegistryStablecoin[];
  READABLE_IDS: Set<string>;
  READABLE_META_BY_ID: Map<string, MockRegistryStablecoin>;
}

/**
 * Build the stubbed export object for `@shared/lib/stablecoins/registry`.
 *
 * Usage:
 *   vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({ stablecoins: [...] }));
 */
export function mockRegistry(options: MockRegistryOptions): MockRegistryExports {
  const { stablecoins, trackedMetaById, frozenStablecoins = [] } = options;
  const activeMetaById = new Map(stablecoins.map((coin) => [coin.id, coin]));
  const frozenMetaById = new Map(frozenStablecoins.map((coin) => [coin.id, coin]));
  const readable = buildStablecoinRegistryIndexes([...stablecoins, ...frozenStablecoins], {
    isActive: (coin) => activeMetaById.has(coin.id),
  }).tracked;
  return {
    TRACKED_STABLECOINS: stablecoins,
    TRACKED_IDS: new Set(stablecoins.map((coin) => coin.id)),
    ACTIVE_STABLECOINS: stablecoins,
    ACTIVE_IDS: new Set(stablecoins.map((coin) => coin.id)),
    ACTIVE_META_BY_ID: activeMetaById,
    TRACKED_META_BY_ID: trackedMetaById ?? activeMetaById,
    FROZEN_STABLECOINS: frozenStablecoins,
    FROZEN_IDS: new Set(frozenStablecoins.map((coin) => coin.id)),
    FROZEN_META_BY_ID: frozenMetaById,
    READABLE_STABLECOINS: [...readable.stablecoins],
    READABLE_IDS: readable.ids,
    READABLE_META_BY_ID: readable.metaById,
  };
}

/** The same fixture universe exposed through the bounded Worker registry. */
export function mockWorkerRuntimeRegistry(options: MockRegistryOptions) {
  const registry = mockRegistry(options);
  return {
    WORKER_TRACKED_STABLECOINS: registry.TRACKED_STABLECOINS,
    WORKER_TRACKED_IDS: registry.TRACKED_IDS,
    WORKER_TRACKED_META_BY_ID: registry.TRACKED_META_BY_ID,
    WORKER_ACTIVE_STABLECOINS: registry.ACTIVE_STABLECOINS,
    WORKER_ACTIVE_IDS: registry.ACTIVE_IDS,
    WORKER_ACTIVE_META_BY_ID: registry.ACTIVE_META_BY_ID,
    WORKER_FROZEN_IDS: registry.FROZEN_IDS,
    WORKER_READABLE_IDS: registry.READABLE_IDS,
    hasWorkerLiveReserves: (coin: MockRegistryStablecoin) => coin.liveReservesConfig != null,
  };
}

/** Keep mixed-owner fixtures on the same metadata universe after a projection cutover. */
export function mockWorkerRuntimeRegistryFromFullRegistry(registry: typeof StablecoinRegistry) {
  // Runtime consumers read these aliases directly; merely re-exporting full
  // metadata fixtures omits the generated projection's top-level fields.
  const project = (coin: (typeof StablecoinRegistry.ACTIVE_STABLECOINS)[number]) => ({
    ...coin,
    pegCurrency: coin.flags?.pegCurrency,
    governance: coin.flags?.governance,
    navToken: coin.flags?.navToken,
  });
  return {
    WORKER_TRACKED_STABLECOINS: registry.TRACKED_STABLECOINS.map(project),
    WORKER_TRACKED_IDS: registry.TRACKED_IDS,
    WORKER_TRACKED_META_BY_ID: new Map([...registry.TRACKED_META_BY_ID].map(([id, coin]) => [id, project(coin)])),
    WORKER_ACTIVE_STABLECOINS: registry.ACTIVE_STABLECOINS.map(project),
    WORKER_ACTIVE_IDS: registry.ACTIVE_IDS,
    WORKER_ACTIVE_META_BY_ID: new Map([...registry.ACTIVE_META_BY_ID].map(([id, coin]) => [id, project(coin)])),
    WORKER_PRE_LAUNCH_STABLECOINS: registry.TRACKED_STABLECOINS.filter((coin) => coin.status === "pre-launch").map(project),
    WORKER_FROZEN_IDS: registry.FROZEN_IDS,
    WORKER_READABLE_IDS: registry.READABLE_IDS,
    hasWorkerLiveReserves: (coin: { liveReservesConfig?: unknown }) => coin.liveReservesConfig != null,
  };
}
