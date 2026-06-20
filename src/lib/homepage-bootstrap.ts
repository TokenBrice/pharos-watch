import type { QueryClient } from "@tanstack/react-query";
import { ApiMetaSchema, type ApiMeta } from "@shared/types/api-meta";
import { FRONTEND_API_QUERY_REGISTRY, type FrontendApiQueryDescriptor } from "@/lib/api-query-registry";
// Shared version/helpers also consumed by homepage-bootstrap-runtime.ts; this
// module adds the Zod-validating layer (ApiMetaSchema, descriptor.schema).
import {
  HOMEPAGE_BOOTSTRAP_VERSION,
  makeBootstrapCodec,
} from "@/lib/homepage-bootstrap-shared";

export { HOMEPAGE_BOOTSTRAP_VERSION };

const registry = FRONTEND_API_QUERY_REGISTRY;

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

const homepageBootstrapCodec = makeBootstrapCodec<HomepageBootstrapQueryId, ApiMeta>({
  descriptors: HOMEPAGE_BOOTSTRAP_DESCRIPTORS,
  normalizeMeta(raw) {
    const meta = ApiMetaSchema.safeParse(raw);
    return meta.success ? meta.data : undefined;
  },
  validateData(id, data) {
    const descriptor = HOMEPAGE_BOOTSTRAP_DESCRIPTORS.find((entry) => entry.id === id)?.descriptor;
    const parsed = descriptor?.schema?.safeParse(data);
    if (parsed && !parsed.success) {
      return null;
    }
    return { data: parsed ? parsed.data : data };
  },
});

export function normalizeHomepageBootstrapPayload(raw: unknown): HomepageBootstrapPayload | null {
  return homepageBootstrapCodec.normalizePayload(raw);
}

export function validateHomepageBootstrapPayloadData(payload: HomepageBootstrapPayload): string[] {
  const errors: string[] = [];
  for (const { id, descriptor } of HOMEPAGE_BOOTSTRAP_DESCRIPTORS) {
    const query = payload.queries[id];
    if (!query || !descriptor.schema) continue;
    const parsed = descriptor.schema.safeParse(query.data);
    if (!parsed.success) {
      errors.push(`${id}: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`);
    }
  }
  return errors;
}

export function countSeedableHomepageBootstrapQueries(
  payload: HomepageBootstrapPayload | null,
  nowMs = Date.now(),
): number {
  return homepageBootstrapCodec.countSeedable(payload, nowMs);
}

export function seedHomepageBootstrapQueries(
  queryClient: QueryClient,
  payload: HomepageBootstrapPayload | null,
  nowMs = Date.now(),
): number {
  return homepageBootstrapCodec.seedQueries(queryClient, payload, nowMs);
}
