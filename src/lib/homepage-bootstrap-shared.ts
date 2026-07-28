import { isRecord } from "@shared/lib/type-guards";

// Shared primitives for the homepage bootstrap payload, used by both the
// build-time module (homepage-bootstrap.ts, Zod-validating) and the
// browser-runtime module (homepage-bootstrap-runtime.ts, Zod-free to keep Zod
// out of the inline-hydration bundle). Keep value/version logic here so the two
// modules can never drift - a one-sided HOMEPAGE_BOOTSTRAP_VERSION bump would
// otherwise silently reject all bootstrap payloads at runtime.

/** Payload schema version. Bump in lockstep with the generator. */
export const HOMEPAGE_BOOTSTRAP_VERSION = 1;

const HOMEPAGE_BOOTSTRAP_QUERY_IDS = [
  "stablecoins",
  "pegSummary",
  "dexLiquidity",
  "reportCardsV9",
  "stressSignals",
  "stabilityIndex",
] as const;

export type HomepageBootstrapQueryId = (typeof HOMEPAGE_BOOTSTRAP_QUERY_IDS)[number];

function normalizeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeSource(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function queryUpdatedAtMs(fetchedAt: number): number {
  return fetchedAt < 10_000_000_000 ? fetchedAt * 1000 : fetchedAt;
}

/** Minimal descriptor shape needed for seedability math; both the build-time
 *  and runtime FrontendApiQueryDescriptor variants satisfy it structurally. */
interface SeedableDescriptor {
  producerIntervalMs: number;
  metaMaxAgeSec?: number;
}

interface BootstrapDescriptor<
  TQueryId extends string,
  TDescriptor extends SeedableDescriptor & {
    path: string;
    queryKey: readonly unknown[];
  } = SeedableDescriptor & {
    path: string;
    queryKey: readonly unknown[];
  },
> {
  id: TQueryId;
  descriptor: TDescriptor;
}

export interface BootstrapQuery<TQueryId extends string, TMeta> {
  id: TQueryId;
  path: string;
  fetchedAt: number;
  data: unknown;
  meta: TMeta | null;
}

export interface BootstrapPayload<TQueryId extends string, TMeta> {
  version: typeof HOMEPAGE_BOOTSTRAP_VERSION;
  generatedAt: number;
  source: string | null;
  queries: Partial<Record<TQueryId, BootstrapQuery<TQueryId, TMeta>>>;
}

interface BootstrapCodecOptions<TQueryId extends string, TMeta> {
  descriptors: readonly BootstrapDescriptor<TQueryId>[];
  normalizeMeta: (raw: unknown) => TMeta | null | undefined;
  validateData?: (id: TQueryId, data: unknown) => { data: unknown } | null;
}

type HomepageBootstrapRegistry = {
  [K in HomepageBootstrapQueryId]: BootstrapDescriptor<HomepageBootstrapQueryId>["descriptor"];
};

type HomepageBootstrapDescriptorForRegistry<TRegistry extends HomepageBootstrapRegistry> = {
  [K in HomepageBootstrapQueryId]: BootstrapDescriptor<K, TRegistry[K]>;
}[HomepageBootstrapQueryId];

export function buildHomepageBootstrapDescriptors<TRegistry extends HomepageBootstrapRegistry>(
  registry: TRegistry,
): readonly HomepageBootstrapDescriptorForRegistry<TRegistry>[] {
  return HOMEPAGE_BOOTSTRAP_QUERY_IDS.map((id) => ({ id, descriptor: registry[id] })) as readonly HomepageBootstrapDescriptorForRegistry<TRegistry>[];
}

export function descriptorMaxAgeMs(descriptor: SeedableDescriptor): number {
  return (descriptor.metaMaxAgeSec ?? descriptor.producerIntervalMs / 1000) * 1000;
}

function isSeedableQuery(
  query: { fetchedAt: number },
  descriptor: SeedableDescriptor,
  nowMs: number,
): boolean {
  return nowMs - queryUpdatedAtMs(query.fetchedAt) <= descriptorMaxAgeMs(descriptor);
}

export function makeBootstrapCodec<TQueryId extends string, TMeta>({
  descriptors,
  normalizeMeta,
  validateData,
}: BootstrapCodecOptions<TQueryId, TMeta>) {
  function normalizeQuery(
    id: TQueryId,
    raw: unknown,
    fallbackPath: string,
  ): BootstrapQuery<TQueryId, TMeta> | null {
    if (!isRecord(raw) || raw.id !== id) {
      return null;
    }

    const fetchedAt = normalizeTimestamp(raw.fetchedAt);
    if (fetchedAt == null || !("data" in raw)) {
      return null;
    }

    const meta = raw.meta == null ? null : normalizeMeta(raw.meta);
    if (meta === undefined) {
      return null;
    }

    return {
      id,
      path: typeof raw.path === "string" && raw.path ? raw.path : fallbackPath,
      fetchedAt,
      data: raw.data,
      meta,
    };
  }

  function normalizePayload(raw: unknown): BootstrapPayload<TQueryId, TMeta> | null {
    if (!isRecord(raw) || raw.version !== HOMEPAGE_BOOTSTRAP_VERSION) {
      return null;
    }

    const generatedAt = normalizeTimestamp(raw.generatedAt);
    if (generatedAt == null || !isRecord(raw.queries)) {
      return null;
    }

    const queries: BootstrapPayload<TQueryId, TMeta>["queries"] = {};
    for (const { id, descriptor } of descriptors) {
      const normalized = normalizeQuery(id, raw.queries[id], descriptor.path);
      if (normalized) {
        queries[id] = normalized;
      }
    }

    return {
      version: HOMEPAGE_BOOTSTRAP_VERSION,
      generatedAt,
      source: normalizeSource(raw.source),
      queries,
    };
  }

  function countSeedable(
    payload: BootstrapPayload<TQueryId, TMeta> | null,
    nowMs = Date.now(),
  ): number {
    if (!payload) {
      return 0;
    }

    let count = 0;
    for (const { id, descriptor } of descriptors) {
      const query = payload.queries[id];
      if (query && isSeedableQuery(query, descriptor, nowMs)) {
        count += 1;
      }
    }
    return count;
  }

  function seedQueries(
    queryClient: { setQueryData: (queryKey: readonly unknown[], value: unknown, options: { updatedAt: number }) => void },
    payload: BootstrapPayload<TQueryId, TMeta> | null,
    nowMs = Date.now(),
  ): number {
    if (!payload) {
      return 0;
    }

    let seeded = 0;
    for (const { id, descriptor } of descriptors) {
      const query = payload.queries[id];
      if (!query) continue;
      if (!isSeedableQuery(query, descriptor, nowMs)) continue;

      const validated = validateData ? validateData(id, query.data) : { data: query.data };
      if (!validated) {
        continue;
      }

      queryClient.setQueryData(
        descriptor.queryKey,
        {
          data: validated.data,
          meta: query.meta,
        },
        { updatedAt: queryUpdatedAtMs(query.fetchedAt) },
      );
      seeded += 1;
    }
    return seeded;
  }

  return { normalizePayload, countSeedable, seedQueries };
}
