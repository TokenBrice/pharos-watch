import { describe, expect, it } from "vitest";
import { baseLiveReserveConfigSchema } from "../live-reserve-adapters-schemas";

describe("baseLiveReserveConfigSchema", () => {
  it("accepts a non-empty breakerScope", () => {
    const result = baseLiveReserveConfigSchema.safeParse({
      version: 1,
      semantics: "collateral-mix",
      breakerScope: "my-scope",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an omitted breakerScope", () => {
    const result = baseLiveReserveConfigSchema.safeParse({
      version: 1,
      semantics: "collateral-mix",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty-string breakerScope", () => {
    const result = baseLiveReserveConfigSchema.safeParse({
      version: 1,
      semantics: "collateral-mix",
      breakerScope: "",
    });
    expect(result.success).toBe(false);
  });
});
