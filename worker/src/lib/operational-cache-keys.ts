declare const operationalCacheKeyBrand: unique symbol;

export type OperationalCacheOwner = "sync-live-reserves";
export type OperationalCacheDomain = "live-reserves";

export type OperationalCacheKey<TKey extends string = string> = TKey & {
  readonly [operationalCacheKeyBrand]: "OperationalCacheKey";
};

export interface OperationalCacheKeyDefinition<TKey extends string = string> {
  readonly key: OperationalCacheKey<TKey>;
  readonly owner: OperationalCacheOwner;
  readonly domain: OperationalCacheDomain;
  readonly purpose: string;
  readonly valueSchema: string;
  readonly ttl: string;
  readonly cleanup: string;
}

function defineOperationalCacheKey<TKey extends string>(
  definition: Omit<OperationalCacheKeyDefinition<TKey>, "key"> & { readonly key: TKey },
): OperationalCacheKeyDefinition<TKey> {
  return definition as OperationalCacheKeyDefinition<TKey>;
}

export const OPERATIONAL_CACHE_KEYS = {
  liveReserveRunCursor: defineOperationalCacheKey({
    key: "live-reserves:run-cursor",
    owner: "sync-live-reserves",
    domain: "live-reserves",
    purpose: "Resume cursor for live-reserve sync runs when the serialized queue defers a tail after run-budget exhaustion.",
    valueSchema: "LiveReserveCursorState JSON from worker/src/cron/sync-live-reserves-run-state.ts",
    ttl: "No time-based TTL; the cursor remains until a completed live-reserve run clears it.",
    cleanup: "Cleared by clearCursorStateIfComplete() after a complete run; overwritten during deferred-tail state transitions.",
  }),
} as const satisfies Record<string, OperationalCacheKeyDefinition>;

export const LIVE_RESERVE_RUN_CURSOR_CACHE_KEY = OPERATIONAL_CACHE_KEYS.liveReserveRunCursor.key;
