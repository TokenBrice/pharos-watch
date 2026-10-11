import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createReviewedAssetRegistry } from "@shared/lib/safety-score-v9/reviewed-registry";

const schema = z.object({
  assetId: z.string(),
  sources: z.array(z.object({ label: z.string(), url: z.string() })),
});

describe("reviewed registry admitted graph retention", () => {
  it("reuses schema-equivalent authored evidence despite nested key insertion order", () => {
    const row = { sources: [{ url: "https://example.com", label: "Evidence" }], assetId: "alpha" };
    const registry = createReviewedAssetRegistry({ rows: [row], schema, path: "reviews" });
    expect(registry.get("alpha")).toBe(row);
    expect(registry.getAll("alpha")).toBe(registry.getAll("alpha"));
    expect(registry.get("alpha")).toEqual(schema.parse(row));
  });

  it("shares unchanged child evidence when a schema default requires a new row", () => {
    const row = { assetId: "alpha", sources: [{ url: "https://example.com", label: "Evidence" }] };
    const defaulted = schema.extend({ reviewed: z.boolean().default(false) });
    const admitted = createReviewedAssetRegistry({ rows: [row], schema: defaulted, path: "reviews" }).get("alpha")!;
    expect(admitted).not.toBe(row);
    expect(admitted.sources).toBe(row.sources);
    expect(admitted).toEqual(defaulted.parse(row));
    expect(row).not.toHaveProperty("reviewed");
  });

  it("retains schema transforms, defaults, stripped keys and array order", () => {
    const row = { assetId: "alpha", sources: [{ label: "  Evidence  ", url: "https://example.com", extra: true }] };
    const transformed = schema.extend({
      sources: z.array(z.object({ url: z.string(), label: z.string().trim() })),
      reviewed: z.boolean().default(false),
    });
    const registry = createReviewedAssetRegistry({ rows: [row], schema: transformed, path: "reviews" });
    expect(registry.get("alpha")).toEqual(transformed.parse(row));
    expect(registry.get("alpha")).not.toBe(row);
    const reverse = schema.transform(value => ({ ...value, sources: [...value.sources].reverse() }));
    const ordered = { assetId: "alpha", sources: [{ label: "A", url: "a" }, { label: "B", url: "b" }] };
    expect(createReviewedAssetRegistry({ rows: [ordered], schema: reverse, path: "reviews" }).get("alpha")).toEqual(reverse.parse(ordered));
  });

  it("rejects malformed evidence before reuse and preserves healthy peers", () => {
    const good = { assetId: "beta", sources: [{ label: "Evidence", url: "https://example.com" }] };
    const registry = createReviewedAssetRegistry({ rows: [{ assetId: "alpha", sources: [{ label: 3 }] }, good], schema, path: "reviews" });
    expect(() => registry.get("alpha")).toThrow("reviews.0.sources.0.label");
    expect(registry.get("beta")).toBe(good);
    expect(registry.get("absent")).toBeUndefined();
  });
});
