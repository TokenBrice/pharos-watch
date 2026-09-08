import { buildDewsStablecoinIdsDigest } from "../dews-publication-pointer";

export function publishedPointer(updatedAt: number, ids?: readonly string[], overrides: Record<string, unknown> = {}) {
  return {
    key: "dews:published-generation",
    value: JSON.stringify({
      updatedAt,
      source: "compute-dews",
      publishStatus: "published",
      ...(ids === undefined ? {} : {
        coverageVersion: 2,
        expectedRowCount: ids.length,
        stablecoinIdsDigest: buildDewsStablecoinIdsDigest(ids),
      }),
      ...overrides,
    }),
    updated_at: updatedAt,
  };
}
