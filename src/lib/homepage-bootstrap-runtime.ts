import type { QueryClient } from "@tanstack/react-query";
import { isRecord } from "@shared/lib/type-guards";
import { normalizeApiMeta, type ApiMeta } from "@/lib/api";
import {
  FRONTEND_API_QUERY_RUNTIME_REGISTRY,
  type FrontendApiQueryDescriptor,
} from "@/lib/api-query-runtime-registry";
// Shared version/helpers also consumed by homepage-bootstrap.ts. This runtime
// module deliberately stays Zod-free (no descriptor.schema validation) to keep
// Zod out of the inline-hydration bundle.
import {
  HOMEPAGE_BOOTSTRAP_VERSION,
  isSeedableQuery,
  normalizeSource,
  normalizeTimestamp,
  queryUpdatedAtMs,
} from "@/lib/homepage-bootstrap-shared";

export const HOMEPAGE_BOOTSTRAP_SCRIPT_ID = "pharos-homepage-bootstrap";

const registry = FRONTEND_API_QUERY_RUNTIME_REGISTRY;

const HOMEPAGE_BOOTSTRAP_DESCRIPTORS = [
  { id: "stablecoins", descriptor: registry.stablecoins },
  { id: "pegSummary", descriptor: registry.pegSummary },
  { id: "dexLiquidity", descriptor: registry.dexLiquidity },
  { id: "reportCards", descriptor: registry.reportCards },
  { id: "stressSignals", descriptor: registry.stressSignals },
  { id: "stabilityIndex", descriptor: registry.stabilityIndex },
] as const satisfies readonly {
  id: string;
  descriptor: FrontendApiQueryDescriptor<unknown>;
}[];

export type HomepageBootstrapQueryId = (typeof HOMEPAGE_BOOTSTRAP_DESCRIPTORS)[number]["id"];

export interface HomepageBootstrapQuery {
  id: HomepageBootstrapQueryId;
  path: string;
  fetchedAt: number;
  data: unknown;
  meta: ApiMeta | null;
}

export interface HomepageBootstrapPayload {
  version: typeof HOMEPAGE_BOOTSTRAP_VERSION;
  generatedAt: number;
  source: string | null;
  queries: Partial<Record<HomepageBootstrapQueryId, HomepageBootstrapQuery>>;
}

function normalizeQuery(
  id: HomepageBootstrapQueryId,
  raw: unknown,
  fallbackPath: string,
): HomepageBootstrapQuery | null {
  if (!isRecord(raw) || raw.id !== id) {
    return null;
  }

  const fetchedAt = normalizeTimestamp(raw.fetchedAt);
  if (fetchedAt == null || !("data" in raw)) {
    return null;
  }

  return {
    id,
    path: typeof raw.path === "string" && raw.path ? raw.path : fallbackPath,
    fetchedAt,
    data: raw.data,
    meta: raw.meta == null ? null : normalizeApiMeta(raw.meta),
  };
}

export function normalizeHomepageBootstrapPayload(raw: unknown): HomepageBootstrapPayload | null {
  if (!isRecord(raw) || raw.version !== HOMEPAGE_BOOTSTRAP_VERSION) {
    return null;
  }

  const generatedAt = normalizeTimestamp(raw.generatedAt);
  if (generatedAt == null || !isRecord(raw.queries)) {
    return null;
  }

  const queries: HomepageBootstrapPayload["queries"] = {};
  for (const { id, descriptor } of HOMEPAGE_BOOTSTRAP_DESCRIPTORS) {
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

export function countSeedableHomepageBootstrapQueries(
  payload: HomepageBootstrapPayload | null,
  nowMs = Date.now(),
): number {
  if (!payload) {
    return 0;
  }

  let count = 0;
  for (const { id, descriptor } of HOMEPAGE_BOOTSTRAP_DESCRIPTORS) {
    const query = payload.queries[id];
    if (query && isSeedableQuery(query, descriptor, nowMs)) {
      count += 1;
    }
  }
  return count;
}

export function seedHomepageBootstrapQueries(
  queryClient: QueryClient,
  payload: HomepageBootstrapPayload | null,
  nowMs = Date.now(),
): number {
  if (!payload) {
    return 0;
  }

  let seeded = 0;
  for (const { id, descriptor } of HOMEPAGE_BOOTSTRAP_DESCRIPTORS) {
    const query = payload.queries[id];
    if (!query) continue;
    if (!isSeedableQuery(query, descriptor, nowMs)) continue;

    queryClient.setQueryData(
      descriptor.queryKey,
      {
        data: query.data,
        meta: query.meta,
      },
      { updatedAt: queryUpdatedAtMs(query.fetchedAt) },
    );
    seeded += 1;
  }
  return seeded;
}

export function readHomepageBootstrapPayloadFromDocument(): HomepageBootstrapPayload | null {
  if (typeof document === "undefined") {
    return null;
  }

  const script = document.getElementById(HOMEPAGE_BOOTSTRAP_SCRIPT_ID);
  const text = script?.textContent;
  if (!text) {
    return null;
  }

  try {
    return normalizeHomepageBootstrapPayload(JSON.parse(text));
  } catch {
    return null;
  }
}
