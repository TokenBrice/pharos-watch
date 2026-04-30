import { describe, expect, it } from "vitest";
import { ApiMetaSchema } from "../api-meta";

describe("ApiMetaSchema", () => {
  it("parses freshness metadata with dependency status details", () => {
    const parsed = ApiMetaSchema.parse({
      updatedAt: 1777555000,
      ageSeconds: 300,
      status: "degraded",
      warning: "110 - \"Response is degraded\"",
      dependencies: {
        reportCards: {
          updatedAt: 1777554800,
          ageSeconds: 500,
          status: "fresh",
          reason: null,
        },
      },
    });

    expect(parsed.dependencies?.reportCards.status).toBe("fresh");
  });

  it("rejects unknown top-level freshness statuses", () => {
    expect(ApiMetaSchema.safeParse({
      updatedAt: 1777555000,
      ageSeconds: 300,
      status: "unavailable",
    }).success).toBe(false);
  });
});
