import { describe, expect, it } from "vitest";
import {
  gunzipTextBounded,
  gzipCanonicalJson,
} from "../canonical-json-gzip";

describe("bounded canonical gzip", () => {
  it("round-trips text within explicit compressed and expanded limits", async () => {
    const text = JSON.stringify({ value: "ok" });
    const compressed = await gzipCanonicalJson(text, {
      label: "fixture",
      maximumCompressedBytes: 1_024,
      maximumUncompressedBytes: 1_024,
    });

    await expect(gunzipTextBounded(compressed.compressed, {
      label: "fixture",
      maximumCompressedBytes: 1_024,
      maximumUncompressedBytes: 1_024,
      expectedUncompressedBytes: compressed.uncompressedBytes,
    })).resolves.toBe(text);
  });

  it("stops decompression at a corrupt declared length before allocating the full payload", async () => {
    const text = JSON.stringify({ value: "x".repeat(256 * 1_024) });
    const compressed = await gzipCanonicalJson(text, {
      label: "fixture",
      maximumCompressedBytes: 4_096,
      maximumUncompressedBytes: 300_000,
    });

    await expect(gunzipTextBounded(compressed.compressed, {
      label: "fixture",
      maximumCompressedBytes: 4_096,
      maximumUncompressedBytes: 300_000,
      expectedUncompressedBytes: 32,
    })).rejects.toThrow("exceeds its declared uncompressed byte length");
  });
});
