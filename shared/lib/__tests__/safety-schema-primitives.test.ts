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

  it("preserves minimal-sink payloads, undefined paths and PropertyKey identity", () => {
    const issues: Array<{ code: "custom"; path?: PropertyKey[]; message: string }> = [];
    const ctx = { addIssue: (value: (typeof issues)[number]) => { issues.push(value); } };
    const key = Symbol("scope");
    const path = ["assets", 2, key];
    issue(ctx, path, "nested");
    issue(ctx, undefined, "absent");
    expect(issues).toEqual([
      { code: "custom", path: ["assets", 2, key], message: "nested" },
      { code: "custom", path: undefined, message: "absent" },
    ]);
    expect(issues[0]!.path).toBe(path);
    expect(Object.prototype.hasOwnProperty.call(issues[1], "path")).toBe(true);
  });

  it("matches complete ordered Zod issues for nested, absent and repeated paths", () => {
    const legacy = z.object({ assets: z.array(z.string().superRefine((value, ctx) => {
      ctx.addIssue({ code: "custom", path: ["facts", 0], message: `Invalid ${value}` });
      ctx.addIssue({ code: "custom", message: "Missing evidence" });
      ctx.addIssue({ code: "custom", path: ["facts", 0], message: "Repeated scope" });
    })) });
    const candidate = z.object({ assets: z.array(z.string().superRefine((value, ctx) => {
      issue(ctx, ["facts", 0], `Invalid ${value}`);
      issue(ctx, undefined, "Missing evidence");
      issue(ctx, ["facts", 0], "Repeated scope");
    })) });
    const input = { assets: ["first", "second"] };
    const before = legacy.safeParse(input);
    const after = candidate.safeParse(input);
    expect(before.success).toBe(false);
    expect(after.success).toBe(false);
    expect(after.error!.issues).toEqual(before.error!.issues);
    expect(after.error!.issues.map(({ path }) => path)).toEqual([
      ["assets", 0, "facts", 0], ["assets", 0], ["assets", 0, "facts", 0],
      ["assets", 1, "facts", 0], ["assets", 1], ["assets", 1, "facts", 0],
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
