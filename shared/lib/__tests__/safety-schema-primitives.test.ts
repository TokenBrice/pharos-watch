import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  BaseInputGenerationIdSchema,
  CanonicalTextSchema,
  FractionSchema,
  Sha256Schema,
  StrictIsoDateSchema,
  UnixSecondsSchema,
  issue,
} from "@shared/types/safety-schema-primitives";

const SHA256 = "a".repeat(64);

describe("canonical safety schema primitives", () => {
  it("preserves complete ordered custom issues with root and nested paths", () => {
    const schema = z.object({
      rows: z.array(z.object({ valid: z.boolean() }).superRefine((row, ctx) => {
        if (row.valid) return;
        issue(ctx, undefined, "root failure");
        issue(ctx, ["valid"], "field failure");
        issue(ctx, ["details", 2], "dynamic failure");
      })),
    });
    expect(schema.parse({ rows: [{ valid: true }] })).toEqual({ rows: [{ valid: true }] });
    const result = schema.safeParse({ rows: [{ valid: true }, { valid: false }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected refinement rejection");
    expect(result.error.issues).toEqual([
      { code: "custom", path: ["rows", 1], message: "root failure" },
      { code: "custom", path: ["rows", 1, "valid"], message: "field failure" },
      { code: "custom", path: ["rows", 1, "details", 2], message: "dynamic failure" },
    ]);
  });

  it("rejects surrounding whitespace instead of silently normalizing it", () => {
    expect(CanonicalTextSchema.safeParse("canonical").success).toBe(true);
    expect(CanonicalTextSchema.safeParse(" canonical").success).toBe(false);
    expect(CanonicalTextSchema.safeParse("canonical ").success).toBe(false);
    expect(CanonicalTextSchema.safeParse("   ").success).toBe(false);
  });

  it("accepts only lowercase SHA-256 and canonical base-input generation IDs", () => {
    expect(Sha256Schema.safeParse(SHA256).success).toBe(true);
    expect(Sha256Schema.safeParse(SHA256.toUpperCase()).success).toBe(false);
    expect(BaseInputGenerationIdSchema.safeParse(`report-cards-input:v1:${SHA256}`).success).toBe(true);
    expect(BaseInputGenerationIdSchema.safeParse(`report-cards-input:v2:${SHA256}`).success).toBe(false);
  });

  it("bounds timestamps and fractions", () => {
    expect(UnixSecondsSchema.safeParse(0).success).toBe(true);
    expect(UnixSecondsSchema.safeParse(-1).success).toBe(false);
    expect(UnixSecondsSchema.safeParse(1.5).success).toBe(false);
    expect(FractionSchema.safeParse(0).success).toBe(true);
    expect(FractionSchema.safeParse(1).success).toBe(true);
    expect(FractionSchema.safeParse(1.001).success).toBe(false);
  });

  it("accepts only real strict ISO calendar dates", () => {
    expect(StrictIsoDateSchema.safeParse("2024-02-29").success).toBe(true);
    expect(StrictIsoDateSchema.safeParse("2023-02-29").success).toBe(false);
    expect(StrictIsoDateSchema.safeParse("2024-2-29").success).toBe(false);
    expect(StrictIsoDateSchema.safeParse("2024-02-29T00:00:00Z").success).toBe(false);
  });
});
