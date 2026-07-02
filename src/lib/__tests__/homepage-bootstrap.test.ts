import { describe, expect, it } from "vitest";
import {
  HOMEPAGE_BOOTSTRAP_VERSION,
  normalizeHomepageBootstrapPayload,
  validateHomepageBootstrapPayloadData,
} from "../homepage-bootstrap";

describe("homepage bootstrap", () => {
  it("normalizes payloads and drops malformed query entries", () => {
    const payload = normalizeHomepageBootstrapPayload({
      version: HOMEPAGE_BOOTSTRAP_VERSION,
      generatedAt: 1_700_000_000_000,
      source: "https://api.pharos.watch",
      queries: {
        stablecoins: {
          id: "stablecoins",
          path: "/api/stablecoins",
          fetchedAt: 1_700_000_000_001,
          data: { peggedAssets: [] },
          meta: { updatedAt: 1_700_000_000, ageSeconds: 5, status: "fresh" },
        },
        dexLiquidity: {
          id: "dexLiquidity",
          fetchedAt: "bad",
          data: {},
          meta: null,
        },
      },
    });

    expect(payload?.queries.stablecoins?.data).toEqual({ peggedAssets: [] });
    expect(payload?.queries.dexLiquidity).toBeUndefined();
  });

  it("validates query data with endpoint schemas", () => {
    const payload = normalizeHomepageBootstrapPayload({
      version: HOMEPAGE_BOOTSTRAP_VERSION,
      generatedAt: 1,
      source: null,
      queries: {
        stablecoins: {
          id: "stablecoins",
          path: "/api/stablecoins",
          fetchedAt: 1,
          data: { peggedAssets: "not-an-array" },
          meta: null,
        },
      },
    });

    expect(payload).not.toBeNull();
    expect(validateHomepageBootstrapPayloadData(payload!)).toEqual([
      expect.stringContaining("stablecoins:"),
    ]);
  });
});
