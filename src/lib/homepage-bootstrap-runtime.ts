import type { QueryClient } from "@tanstack/react-query";
import type { ApiMeta } from "@/lib/api";
import {
  FRONTEND_API_QUERY_RUNTIME_REGISTRY,
  type FrontendApiQueryDescriptor,
} from "@/lib/api-query-runtime-registry";

export const HOMEPAGE_BOOTSTRAP_SCRIPT_ID = "pharos-homepage-bootstrap";
const HOMEPAGE_BOOTSTRAP_VERSION = 1;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeSource(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeDependencyMeta(value: unknown): ApiMeta["dependencies"] extends infer D ? D : never {
  if (!isRecord(value)) return undefined as never;
  const normalized: Record<string, {
    updatedAt?: number | null;
    ageSeconds?: number | null;
    status: "fresh" | "degraded" | "stale" | "unavailable";
    reason?: string | null;
  }> = {};

  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const status = raw.status;
    if (status !== "fresh" && status !== "degraded" && status !== "stale" && status !== "unavailable") {
      continue;
    }
    normalized[key] = {
      status,
      updatedAt: typeof raw.updatedAt === "number" || raw.updatedAt === null ? raw.updatedAt : undefined,
      ageSeconds: typeof raw.ageSeconds === "number" || raw.ageSeconds === null ? raw.ageSeconds : undefined,
      reason: typeof raw.reason === "string" || raw.reason === null ? raw.reason : undefined,
    };
  }

  return normalized as never;
}

function normalizeApiMeta(value: unknown): ApiMeta | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (status !== "fresh" && status !== "degraded" && status !== "stale") {
    return null;
  }
  if (typeof value.updatedAt !== "number" || typeof value.ageSeconds !== "number") {
    return null;
  }
  return {
    updatedAt: value.updatedAt,
    ageSeconds: value.ageSeconds,
    status,
    warning: typeof value.warning === "string" || value.warning === null ? value.warning : undefined,
    dependencies: normalizeDependencyMeta(value.dependencies),
  };
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

function queryUpdatedAtMs(fetchedAt: number): number {
  return fetchedAt < 10_000_000_000 ? fetchedAt * 1000 : fetchedAt;
}

function descriptorMaxAgeMs(descriptor: FrontendApiQueryDescriptor<unknown>): number {
  return (descriptor.metaMaxAgeSec ?? descriptor.producerIntervalMs / 1000) * 1000;
}

function isSeedableQuery(
  query: HomepageBootstrapQuery,
  descriptor: FrontendApiQueryDescriptor<unknown>,
  nowMs: number,
): boolean {
  return nowMs - queryUpdatedAtMs(query.fetchedAt) <= descriptorMaxAgeMs(descriptor);
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
