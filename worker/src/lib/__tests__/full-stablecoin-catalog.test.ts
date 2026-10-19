import { gzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import sourceAsset from "@shared/data/stablecoins/coins.generated.json";
import * as canonicalRegistry from "@shared/lib/stablecoins/registry";
import { ReviewEvidenceBuilder } from "@shared/lib/safety-score-v9/review-evidence";
import decodedAsset, { decodeWorkerStablecoinCatalog } from "../full-stablecoin-catalog";

function fixture(record: unknown, id = "fixture") {
  const raw = Buffer.from(JSON.stringify(record));
  return { version: 2, maxUncompressedBytes: raw.length, coins: [[id, raw.length, Buffer.from(gzipSync(raw)).toString("base64")] as const] };
}

function packReviews(records: readonly { id: string; blacklistabilityReview: unknown }[]) {
  const rows = records.map((record) => {
    const packed = fixture({ ...record, blacklistabilityReview: null }, record.id);
    const review = Buffer.from(JSON.stringify(record.blacklistabilityReview));
    return [...packed.coins[0], { blacklistabilityReview: [review.length, Buffer.from(gzipSync(review)).toString("base64")] as const }] as const;
  });
  return { version: 2, maxUncompressedBytes: Math.max(...rows.flatMap((row) => [row[1], row[3].blacklistabilityReview[0]])), coins: rows };
}

afterEach(() => {
  vi.doUnmock("#pharos-full-catalog");
  vi.resetModules();
});

describe("Worker full stablecoin catalog", () => {
  it("preserves every complete source record, its order, and its evidence hash", () => {
    expect(decodedAsset).toEqual(sourceAsset);
    expect(decodedAsset.map((coin) => coin.id)).toEqual(sourceAsset.map((coin) => coin.id));
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    expect(decodedAsset.map(digest)).toEqual(sourceAsset.map(digest));
  });

  it("keeps both reviewed domains non-caching across the full cohort", () => {
    for (const coin of decodedAsset) {
      for (const field of ["blacklistabilityReview", "mintAuthority"] as const) {
        const first = coin[field];
        if (first == null) continue;
        expect(Object.getOwnPropertyDescriptor(coin, field)?.get).toBeTypeOf("function");
        expect(coin[field]).toEqual(first);
        expect(coin[field]).not.toBe(first);
      }
    }
  });

  it("keeps repeated evidence strings lossless without aliasing mutable records", () => {
    const text = "Repeated evidence ".repeat(100);
    const first = fixture({ id: "one", evidence: { text } }, "one");
    const second = fixture({ id: "two", evidence: { text } }, "two");
    const decoded = decodeWorkerStablecoinCatalog({
      version: 2, maxUncompressedBytes: Math.max(first.maxUncompressedBytes, second.maxUncompressedBytes),
      coins: [...first.coins, ...second.coins],
    });
    expect(decoded).toEqual([{ id: "one", evidence: { text } }, { id: "two", evidence: { text } }]);
    expect(decoded[0]).not.toBe(decoded[1]);
  });

  it("keeps reviews lazy and lossless through repeated reads, serialization and evidence hashing", () => {
    const records = [{ id: "fixture", blacklistabilityReview: {
      reviewedStatus: false, sources: [
        { label: "Source", url: "https://example.com" },
        { label: "Pinned contract", url: "https://example.com/block/123" },
      ],
      evidence: "Pinned Unicode evidence \u20ac ".repeat(100), reviewedAt: "2026-10-01", reviewer: "reviewer",
    } }];
    const packed = packReviews(records);
    const decoded = decodeWorkerStablecoinCatalog(packed);
    // Review getters own compressed bytes independently of the transport.
    packed.coins.length = 0;
    const review = decoded[0].blacklistabilityReview!;
    const getter = Object.getOwnPropertyDescriptor(decoded[0], "blacklistabilityReview")?.get;
    expect(getter).toBeTypeOf("function");
    expect(review.evidence).toBe(records[0].blacklistabilityReview.evidence);
    expect(decoded[0].blacklistabilityReview).toEqual(review);
    expect(decoded[0].blacklistabilityReview).not.toBe(review);
    expect(Object.getOwnPropertyDescriptor(decoded[0], "blacklistabilityReview")?.get).toBe(getter);
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(records));
    expect(decoded).toEqual(records);
    const buildEvidence = (payload: typeof review) => {
      const builder = new ReviewEvidenceBuilder("fixture", Date.parse("2026-10-19") / 1_000);
      builder.add({
        componentKeys: ["access:freeze"], sourceId: "stablecoin-meta.blacklistability-review",
        reviewedAt: payload.reviewedAt, sources: payload.sources, payload,
      });
      return builder.finish();
    };
    expect(buildEvidence(review)).toEqual(buildEvidence(records[0].blacklistabilityReview));
  });

  it("rejects malformed or unbounded lazy evidence before publishing records", () => {
    const packed = packReviews([{ id: "fixture", blacklistabilityReview: { evidence: "review evidence" } }]);
    const row = packed.coins[0];
    expect(() => decodeWorkerStablecoinCatalog({ ...packed, coins: [[...row.slice(0, 3), { blacklistabilityReview: [1, "AAA!"] }]] })).toThrow("base64");
    expect(() => decodeWorkerStablecoinCatalog({ ...packed, coins: [[...row.slice(0, 3), { blacklistabilityReview: [packed.maxUncompressedBytes + 1, row[3].blacklistabilityReview[1]] }]] })).toThrow("record");
    expect(() => decodeWorkerStablecoinCatalog({ ...packed, coins: [[...row.slice(0, 3), []]] })).toThrow("evidence");
  });

  it("preserves every registry array, map and set including suspended-feed normalization", async () => {
    vi.doMock("#pharos-full-catalog", () => ({ default: decodedAsset }));
    vi.resetModules();
    const workerRegistry = await import("@shared/lib/stablecoins/registry");
    for (const [key, expected] of Object.entries(canonicalRegistry)) {
      if (typeof expected === "function") continue;
      expect(workerRegistry[key as keyof typeof workerRegistry], key).toEqual(expected);
    }
  });

  it("rejects empty catalogs and zero-size manifests before decoding", () => {
    expect(() => decodeWorkerStablecoinCatalog({
      version: 2, maxUncompressedBytes: 0, coins: [],
    })).toThrow("Invalid packed stablecoin catalog manifest");
    expect(() => decodeWorkerStablecoinCatalog({
      version: 2, maxUncompressedBytes: 1, coins: [],
    })).toThrow("Invalid packed stablecoin catalog manifest");
    expect(() => decodeWorkerStablecoinCatalog({
      ...fixture({ id: "fixture" }), maxUncompressedBytes: 0,
    })).toThrow("Invalid packed stablecoin catalog manifest");
  });

  it("rejects identity and inflate-length mismatches before publishing a catalog", () => {
    expect(() => decodeWorkerStablecoinCatalog(fixture({ id: "wrong" }))).toThrow("identity mismatch");
    const invalidSize = fixture({ id: "fixture" });
    invalidSize.coins[0] = ["fixture", invalidSize.maxUncompressedBytes - 1, invalidSize.coins[0][2]];
    expect(() => decodeWorkerStablecoinCatalog(invalidSize)).toThrow("length mismatch");
    const oversized = fixture({ id: "fixture" });
    oversized.maxUncompressedBytes -= 1;
    expect(() => decodeWorkerStablecoinCatalog(oversized)).toThrow("Invalid packed stablecoin record");
  });

  it("rejects invalid base64 alphabets, lengths and padding before decoding", () => {
    for (const payload of ["AAA!", "AAA_", "AAA ", "AAA\n", "AAA", "=AAA", "A===", "AA=A", "AAAA===="]) {
      expect(() => decodeWorkerStablecoinCatalog({
        version: 2,
        maxUncompressedBytes: 1,
        coins: [["fixture", 1, payload]],
      }), payload).toThrow("Invalid packed stablecoin base64");
    }
    // Syntactically valid encodings reach the separate gzip-length check.
    for (const payload of ["", "AAAA", "AA==", "AAA="]) {
      expect(() => decodeWorkerStablecoinCatalog({
        version: 2,
        maxUncompressedBytes: 1,
        coins: [["fixture", 1, payload]],
      }), payload).toThrow("length mismatch");
    }
  });

  it("rejects duplicate ids and unsupported manifests", () => {
    const duplicate = fixture({ id: "fixture" });
    duplicate.coins.push(duplicate.coins[0]);
    expect(() => decodeWorkerStablecoinCatalog(duplicate)).toThrow("Invalid packed stablecoin record");
    expect(() => decodeWorkerStablecoinCatalog({ ...duplicate, version: 1 })).toThrow("manifest");
  });
});
