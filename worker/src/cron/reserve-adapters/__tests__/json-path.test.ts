import { describe, expect, it } from "vitest";
import { getJsonPath } from "../json-path";

describe("getJsonPath", () => {
  it("reads numeric array indices mid-path", () => {
    const payload = { chains: [{ lastSyncedAt: "2026-09-09T14:30:00.096Z" }] };
    expect(getJsonPath(payload, ["chains", "0", "lastSyncedAt"])).toBe("2026-09-09T14:30:00.096Z");
  });

  it("returns null for a non-numeric key on an array", () => {
    expect(getJsonPath({ chains: [{ lastSyncedAt: "x" }] }, ["chains", "lastSyncedAt"])).toBeNull();
  });

  it("returns undefined for an out-of-range array index", () => {
    expect(getJsonPath({ chains: [] }, ["chains", "0"])).toBeUndefined();
  });

  it("keeps object-key access when an object has a numeric string key", () => {
    expect(getJsonPath({ "0": "kept" }, ["0"])).toBe("kept");
  });

  it("returns null when traversing through a primitive", () => {
    expect(getJsonPath({ a: 1 }, ["a", "b"])).toBeNull();
  });
});
