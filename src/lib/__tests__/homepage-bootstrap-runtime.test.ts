import { describe, expect, it } from "vitest";
import { normalizeHomepageBootstrapPayload } from "../homepage-bootstrap-runtime";

function payloadWithMeta(meta: unknown) {
  return {
    version: 1,
    generatedAt: 1_700_000_000_000,
    source: " https://api.pharos.watch ",
    queries: {
      stablecoins: {
        id: "stablecoins",
        fetchedAt: 1_700_000_000_001,
        data: { peggedAssets: [] },
        meta,
      },
    },
  };
}

describe("homepage bootstrap runtime metadata parsing", () => {
  it.each(["fresh", "degraded", "stale"] as const)("normalizes %s API meta", (status) => {
    const payload = normalizeHomepageBootstrapPayload(payloadWithMeta({
      updatedAt: 1_700_000_000,
      ageSeconds: 12,
      status,
      warning: null,
    }));

    expect(payload?.source).toBe("https://api.pharos.watch");
    expect(payload?.queries.stablecoins?.meta).toEqual({
      updatedAt: 1_700_000_000,
      ageSeconds: 12,
      status,
      warning: null,
      dependencies: undefined,
    });
  });

  it("keeps the query but drops invalid API meta", () => {
    const payload = normalizeHomepageBootstrapPayload(payloadWithMeta({
      updatedAt: 1_700_000_000,
      ageSeconds: 12,
      status: "unavailable",
    }));

    expect(payload?.queries.stablecoins?.data).toEqual({ peggedAssets: [] });
    expect(payload?.queries.stablecoins?.meta).toBeNull();
  });

  it("normalizes valid dependency metadata and skips malformed dependencies", () => {
    const payload = normalizeHomepageBootstrapPayload(payloadWithMeta({
      updatedAt: 1_700_000_000,
      ageSeconds: 12,
      status: "degraded",
      dependencies: {
        prices: {
          updatedAt: 1_699_999_900,
          ageSeconds: 112,
          status: "fresh",
          reason: null,
        },
        reserves: {
          updatedAt: "bad",
          ageSeconds: null,
          status: "unavailable",
          reason: "source unavailable",
        },
        malformed: {
          status: "unknown",
        },
      },
    }));

    expect(payload?.queries.stablecoins?.meta?.dependencies).toEqual({
      prices: {
        updatedAt: 1_699_999_900,
        ageSeconds: 112,
        status: "fresh",
        reason: null,
      },
      reserves: {
        updatedAt: undefined,
        ageSeconds: null,
        status: "unavailable",
        reason: "source unavailable",
      },
    });
  });
});
