import { describe, expect, it } from "vitest";
import {
  gunzipBytesBounded,
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

  it("round-trips bytes exactly through the preallocated declared-length path", async () => {
    const text = JSON.stringify({ value: "y".repeat(200 * 1_024) });
    const compressed = await gzipCanonicalJson(text, {
      label: "fixture",
      maximumCompressedBytes: 16_384,
      maximumUncompressedBytes: 300_000,
    });

    const output = await gunzipBytesBounded(compressed.compressed, {
      label: "fixture",
      maximumCompressedBytes: 16_384,
      maximumUncompressedBytes: 300_000,
      expectedUncompressedBytes: compressed.uncompressedBytes,
    });
    expect(output.byteLength).toBe(compressed.uncompressedBytes);
    expect(new TextDecoder().decode(output)).toBe(text);
  });

  it("round-trips text without a declared length", async () => {
    const text = JSON.stringify({ value: "unsized" });
    const compressed = await gzipCanonicalJson(text, {
      label: "fixture",
      maximumCompressedBytes: 1_024,
      maximumUncompressedBytes: 1_024,
    });

    await expect(gunzipTextBounded(compressed.compressed, {
      label: "fixture",
      maximumCompressedBytes: 1_024,
      maximumUncompressedBytes: 1_024,
    })).resolves.toBe(text);
  });

  it("rejects payloads over the uncompressed limit when no length is declared", async () => {
    const text = JSON.stringify({ value: "z".repeat(64 * 1_024) });
    const compressed = await gzipCanonicalJson(text, {
      label: "fixture",
      maximumCompressedBytes: 4_096,
      maximumUncompressedBytes: 200_000,
    });

    await expect(gunzipTextBounded(compressed.compressed, {
      label: "fixture",
      maximumCompressedBytes: 4_096,
      maximumUncompressedBytes: 1_024,
    })).rejects.toThrow("exceeds the uncompressed byte limit; maximum is 1024");
  });

  it("rejects a declared length the payload does not fill", async () => {
    const text = JSON.stringify({ value: "short" });
    const compressed = await gzipCanonicalJson(text, {
      label: "fixture",
      maximumCompressedBytes: 1_024,
      maximumUncompressedBytes: 1_024,
    });

    await expect(gunzipTextBounded(compressed.compressed, {
      label: "fixture",
      maximumCompressedBytes: 1_024,
      maximumUncompressedBytes: 1_024,
      expectedUncompressedBytes: compressed.uncompressedBytes + 1,
    })).rejects.toThrow("payload length mismatch");
  });

  it("rejects a declared length above the uncompressed limit before decompressing", async () => {
    const text = JSON.stringify({ value: "ok" });
    const compressed = await gzipCanonicalJson(text, {
      label: "fixture",
      maximumCompressedBytes: 1_024,
      maximumUncompressedBytes: 1_024,
    });

    await expect(gunzipTextBounded(compressed.compressed, {
      label: "fixture",
      maximumCompressedBytes: 1_024,
      maximumUncompressedBytes: 64,
      expectedUncompressedBytes: 65,
    })).rejects.toThrow("exceeds the uncompressed byte limit; maximum is 64");
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
