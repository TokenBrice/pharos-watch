import { describe, expect, it } from "vitest";
import { getJsonPath } from "../json-path";

describe("getJsonPath", () => {
  it("reads nested object keys", () => {
    expect(getJsonPath({ a: { b: 1 } }, ["a", "b"])).toBe(1);
  });

  it("reads numeric array indices mid-path", () => {
    const payload = { chains: [{ lastSyncedAt: "2026-09-09T14:30:00.096Z" }] };
    expect(getJsonPath(payload, ["chains", "0", "lastSyncedAt"])).toBe("2026-09-09T14:30:00.096Z");
  });

  it("reads a numeric array index as the final path segment", () => {
    expect(getJsonPath({ chains: [{ name: "Ethereum" }, { name: "Base" }] }, ["chains", "1", "name"])).toBe("Base");
  });

  it("returns null for a non-numeric key on an array", () => {
    expect(getJsonPath({ chains: [{ lastSyncedAt: "x" }] }, ["chains", "lastSyncedAt"])).toBeNull();
  });

  it("returns undefined for an out-of-range array index", () => {
    expect(getJsonPath({ chains: [] }, ["chains", "0"])).toBeUndefined();
  });

  it("returns null for an oversized numeric array index", () => {
    expect(getJsonPath({ chains: [{ a: 1 }] }, ["chains", "99999999999999999999999"])).toBeNull();
  });

  it("keeps object-key access when an object has a numeric string key", () => {
    expect(getJsonPath({ "0": "kept" }, ["0"])).toBe("kept");
  });

  it("returns null when traversing through a primitive", () => {
    expect(getJsonPath({ a: 1 }, ["a", "b"])).toBeNull();
  });
});
