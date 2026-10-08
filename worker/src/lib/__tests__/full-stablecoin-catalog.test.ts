import { gzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import sourceAsset from "@shared/data/stablecoins/coins.generated.json";
import * as canonicalRegistry from "@shared/lib/stablecoins/registry";
import decodedAsset, { decodeWorkerStablecoinCatalog } from "../full-stablecoin-catalog";

function fixture(record: unknown, id = "fixture") {
  const raw = Buffer.from(JSON.stringify(record));
  return { version: 1, maxUncompressedBytes: raw.length, coins: [[id, raw.length, Buffer.from(gzipSync(raw)).toString("base64")] as const] };
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

  it("preserves every registry array, map and set including suspended-feed normalization", async () => {
    vi.doMock("#pharos-full-catalog", () => ({ default: decodedAsset }));
    vi.resetModules();
    const workerRegistry = await import("@shared/lib/stablecoins/registry");
    for (const [key, expected] of Object.entries(canonicalRegistry)) {
      if (typeof expected === "function") continue;
      expect(workerRegistry[key as keyof typeof workerRegistry], key).toEqual(expected);
    }
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
        version: 1,
        maxUncompressedBytes: 1,
        coins: [["fixture", 1, payload]],
      }), payload).toThrow("Invalid packed stablecoin base64");
    }
    // Syntactically valid encodings reach the separate gzip-length check.
    for (const payload of ["", "AAAA", "AA==", "AAA="]) {
      expect(() => decodeWorkerStablecoinCatalog({
        version: 1,
        maxUncompressedBytes: 1,
        coins: [["fixture", 1, payload]],
      }), payload).toThrow("length mismatch");
    }
  });

  it("rejects duplicate ids and unsupported manifests", () => {
    const duplicate = fixture({ id: "fixture" });
    duplicate.coins.push(duplicate.coins[0]);
    expect(() => decodeWorkerStablecoinCatalog(duplicate)).toThrow("Invalid packed stablecoin record");
    expect(() => decodeWorkerStablecoinCatalog({ ...duplicate, version: 2 })).toThrow("manifest");
  });
});
