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
  /** The active stablecoin list. Drives ACTIVE_*, TRACKED_*, READABLE_*. */
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
    READABLE_STABLECOINS: stablecoins,
    READABLE_IDS: new Set(stablecoins.map((coin) => coin.id)),
    READABLE_META_BY_ID: activeMetaById,
  };
}
