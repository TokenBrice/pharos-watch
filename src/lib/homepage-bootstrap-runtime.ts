import type { QueryClient } from "@tanstack/react-query";
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
  makeBootstrapCodec,
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

const homepageBootstrapCodec = makeBootstrapCodec<HomepageBootstrapQueryId, ApiMeta>({
  descriptors: HOMEPAGE_BOOTSTRAP_DESCRIPTORS,
  normalizeMeta: normalizeApiMeta,
});

export function normalizeHomepageBootstrapPayload(raw: unknown): HomepageBootstrapPayload | null {
  return homepageBootstrapCodec.normalizePayload(raw);
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
