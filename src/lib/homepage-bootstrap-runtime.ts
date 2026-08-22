import type { QueryClient } from "@tanstack/react-query";
import { normalizeApiMeta, type ApiMeta } from "@/lib/api";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
// Shared version/helpers also consumed by homepage-bootstrap.ts. This runtime
// module deliberately stays Zod-free (no descriptor.schema validation) to keep
// Zod out of the inline-hydration bundle.
import {
  buildHomepageBootstrapDescriptors,
  makeBootstrapCodec,
  type BootstrapPayload,
  type BootstrapQuery,
  type HomepageBootstrapQueryId,
} from "@shared/lib/homepage-bootstrap-shared";

export const HOMEPAGE_BOOTSTRAP_SCRIPT_ID = "pharos-homepage-bootstrap";

const HOMEPAGE_BOOTSTRAP_DESCRIPTORS = buildHomepageBootstrapDescriptors(FRONTEND_API_QUERY_DESCRIPTORS);

export type { HomepageBootstrapQueryId };

export type HomepageBootstrapQuery = BootstrapQuery<HomepageBootstrapQueryId, ApiMeta>;
export type HomepageBootstrapPayload = BootstrapPayload<HomepageBootstrapQueryId, ApiMeta>;

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
