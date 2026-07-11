import { ApiMetaSchema, type ApiMeta } from "@shared/types/api-meta";
import { FRONTEND_API_QUERY_REGISTRY } from "@/lib/api-query-registry";
import { resolveSchemaLike, type SchemaLikeSource } from "@/lib/schema-like";
// Shared version/helpers also consumed by homepage-bootstrap-runtime.ts; this
// module adds the Zod-validating layer (ApiMetaSchema, descriptor.schema).
import {
  HOMEPAGE_BOOTSTRAP_VERSION,
  buildHomepageBootstrapDescriptors,
  makeBootstrapCodec,
  type HomepageBootstrapQueryId,
} from "@/lib/homepage-bootstrap-shared";

export { HOMEPAGE_BOOTSTRAP_VERSION, type HomepageBootstrapQueryId };

const HOMEPAGE_BOOTSTRAP_DESCRIPTORS = buildHomepageBootstrapDescriptors(FRONTEND_API_QUERY_REGISTRY);

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
});

export function normalizeHomepageBootstrapPayload(raw: unknown): HomepageBootstrapPayload | null {
  return homepageBootstrapCodec.normalizePayload(raw);
}

export async function validateHomepageBootstrapPayloadData(
  payload: HomepageBootstrapPayload,
): Promise<string[]> {
  const results = await Promise.all(HOMEPAGE_BOOTSTRAP_DESCRIPTORS.map(async ({ id, descriptor }) => {
    const query = payload.queries[id];
    const schema = await resolveSchemaLike(descriptor.schema as SchemaLikeSource<unknown> | undefined);
    if (!query || !schema) return null;
    const parsed = schema.safeParse(query.data);
    return parsed.success
      ? null
      : `${id}: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`;
  }));
  return results.filter((error): error is string => error !== null);
}
