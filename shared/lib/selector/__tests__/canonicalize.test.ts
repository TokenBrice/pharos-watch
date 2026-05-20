import { describe, expect, it } from "vitest";
import {
  canonicalizeForDatasetHash,
  canonicalizeForSid,
} from "../canonicalize";
import { sha256Hex } from "../hash";

describe("canonicalizeForSid — top-level strip-list", () => {
  it("strips top-level `timestamp`", () => {
    const a = canonicalizeForSid({ profile: "treasury", timestamp: 1000 });
    const b = canonicalizeForSid({ profile: "treasury", timestamp: 9999999 });
    expect(a).toBe(b);
  });

  it("strips top-level `perInputStaleness`", () => {
    const a = canonicalizeForSid({ x: 1, perInputStaleness: { dews: 30 } });
    const b = canonicalizeForSid({ x: 1, perInputStaleness: { dews: 999 } });
    expect(a).toBe(b);
  });
});

describe("canonicalizeForSid — name-pattern strip", () => {
  it("strips fields named *ageSeconds at any depth", () => {
    const a = canonicalizeForSid({
      recommended: [{ id: "x", freshness: { capturedAt: 1, ageSeconds: 10 } }],
    });
    const b = canonicalizeForSid({
      recommended: [{ id: "x", freshness: { capturedAt: 2, ageSeconds: 99 } }],
    });
    expect(a).toBe(b);
  });

  it("strips *capturedAt, *updatedAt, *fetchedAt, *stalenessMs", () => {
    const a = canonicalizeForSid({
      meta: { dataUpdatedAt: 100, fetchedAt: 50, stalenessMs: 0 },
    });
    const b = canonicalizeForSid({
      meta: { dataUpdatedAt: 9999, fetchedAt: 8888, stalenessMs: 777 },
    });
    expect(a).toBe(b);
  });
});

describe("canonicalizeForSid — content fields contribute to sid", () => {
  it("does NOT strip coverageWarnings.newListingCount (content-derived)", () => {
    const a = canonicalizeForSid({
      coverageWarnings: { newListingCount: 1, skippedForCoverageCount: 5 },
    });
    const b = canonicalizeForSid({
      coverageWarnings: { newListingCount: 99, skippedForCoverageCount: 5 },
    });
    // Two outputs differing only on newListingCount must yield distinct sids:
    // newListingCount is computed from per-coin `isRecentListing` flags
    // (content), not from a timestamp.
    expect(a).not.toBe(b);
  });
});

describe("canonicalizeForSid — content preservation", () => {
  it("sorts object keys recursively", () => {
    const a = canonicalizeForSid({ b: 2, a: 1, c: { z: 9, y: 8 } });
    const b = canonicalizeForSid({ a: 1, c: { y: 8, z: 9 }, b: 2 });
    expect(a).toBe(b);
  });

  it("preserves arrays in order", () => {
    expect(canonicalizeForSid({ arr: [3, 1, 2] })).toBe('{"arr":[3,1,2]}');
  });

  it("NFC-normalizes strings", () => {
    // U+00C5 vs U+0041 U+030A (Å in two normalization forms)
    const composed = canonicalizeForSid({ name: "Å" });
    const decomposed = canonicalizeForSid({ name: "Å" });
    expect(composed).toBe(decomposed);
  });

  it("throws on non-finite numbers", () => {
    expect(() => canonicalizeForSid({ x: Infinity })).toThrow();
    expect(() => canonicalizeForSid({ x: NaN })).toThrow();
  });

  it("strips undefined keys", () => {
    expect(canonicalizeForSid({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("canonicalizeForDatasetHash", () => {
  it("uses the same strip rules", () => {
    const a = canonicalizeForDatasetHash({
      coins: [{ id: "x", dataUpdatedAt: 1, score: 80 }],
    });
    const b = canonicalizeForDatasetHash({
      coins: [{ id: "x", dataUpdatedAt: 999, score: 80 }],
    });
    expect(a).toBe(b);
  });

  it("pairs with the synchronous SHA-256 helper", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("freshness-perturbation fixtures", () => {
  it("same content + different timestamps → same sid", () => {
    const base = {
      profile: "treasury",
      timestamp: 1000,
      datasetHash: "abc",
      // newListingCount is content-derived and contributes to sid; both sides
      // share the same content so it stays equal across the perturbation.
      coverageWarnings: { newListingCount: 3, sparse: false },
      recommended: [
        {
          id: "usdc-circle",
          recommendedSource: null,
          perInputStaleness: { pegSummary: 30 },
        },
      ],
    };
    const drift = {
      profile: "treasury",
      timestamp: 2_000_000,
      datasetHash: "abc",
      coverageWarnings: { newListingCount: 3, sparse: false },
      recommended: [
        {
          id: "usdc-circle",
          recommendedSource: null,
          perInputStaleness: { pegSummary: 9999 },
        },
      ],
    };
    expect(canonicalizeForSid(base)).toBe(canonicalizeForSid(drift));
  });
});
