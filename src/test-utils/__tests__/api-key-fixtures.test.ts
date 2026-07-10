import { describe, expect, it } from "vitest";
import { ApiKeyListResponseSchema } from "@shared/types/api-keys";
import { makeApiKeySummary, makeLargeApiKeyInventory } from "@/test-utils/api-key-fixtures";

describe("API key review fixtures", () => {
  it("builds a large, typed, sanitized inventory deterministically", () => {
    const inventory = makeLargeApiKeyInventory();
    const parsed = ApiKeyListResponseSchema.parse(inventory);

    expect(parsed.keys).toHaveLength(75);
    expect(new Set(parsed.keys.map((key) => key.id)).size).toBe(75);
    expect(new Set(parsed.keys.map((key) => key.keyPrefix)).size).toBe(75);
    expect(parsed.keys.every((key) => key.ownerEmail?.endsWith("@example.invalid"))).toBe(true);
    expect(parsed.keys.some((key) => !key.isActive)).toBe(true);
    expect(parsed.keys.some((key) => key.expiresAt == null)).toBe(true);
    expect(makeLargeApiKeyInventory()).toEqual(inventory);
  });

  it("supports bounded inventory sizes and targeted overrides", () => {
    expect(makeLargeApiKeyInventory(-4).keys).toEqual([]);
    expect(makeLargeApiKeyInventory(2.9).keys).toHaveLength(2);
    expect(makeApiKeySummary(0, { name: "Fixture override", ownerEmail: null })).toMatchObject({
      id: 1,
      name: "Fixture override",
      ownerEmail: null,
    });
  });
});
