import { describe, expect, it } from "vitest";
import { assertNotFrozen } from "../frozen-guards";

describe("assertNotFrozen", () => {
  it("returns null for non-frozen ids", () => {
    expect(assertNotFrozen("usdt-tether", new Set(["usr-resolv"]))).toBeNull();
  });

  it("returns a 403 Response for frozen ids", () => {
    const response = assertNotFrozen("usr-resolv", new Set(["usr-resolv"]));
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
  });
});
