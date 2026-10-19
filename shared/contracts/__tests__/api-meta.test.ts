import { describe, expect, it } from "vitest";
import { ApiDependencyMetaSchema, ApiMetaEnvelopeSchema, ApiMetaSchema } from "@pharos/contracts/api-meta";

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

  it("retains independent dependency budget and accepted generation without requiring them on legacy entries", () => {
    const dependency = {
      updatedAt: 1777550000,
      ageSeconds: 5000,
      status: "stale",
      reason: "source-stale",
      freshBudgetSec: 3600,
      generationId: "safety-publication-accepted",
    };
    expect(ApiDependencyMetaSchema.parse(dependency)).toEqual(dependency);
    expect(ApiDependencyMetaSchema.parse({ status: "unavailable", reason: "source-missing" }))
      .toEqual({ status: "unavailable", reason: "source-missing" });
    expect(ApiDependencyMetaSchema.safeParse({ ...dependency, freshBudgetSec: -1 }).success).toBe(false);
    expect(ApiDependencyMetaSchema.safeParse({ ...dependency, freshBudgetSec: Infinity }).success).toBe(false);
  });

  it("rejects unknown top-level freshness statuses", () => {
    expect(ApiMetaSchema.safeParse({
      updatedAt: 1777555000,
      ageSeconds: 300,
      status: "unavailable",
    }).success).toBe(false);
  });

  it("parses the explicit warning-only envelope without timestamps", () => {
    expect(ApiMetaEnvelopeSchema.parse({
      status: "degraded",
      warning: '110 - "Response is degraded"',
    })).toEqual({
      status: "degraded",
      warning: '110 - "Response is degraded"',
    });
  });
});
