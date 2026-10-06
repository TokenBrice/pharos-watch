import { Buffer } from "node:buffer";
import { gunzipSync } from "fflate";
import packedAsset from "@shared/data/stablecoins/coins.worker-full.generated.json";
import type { StablecoinMeta } from "@shared/types/core";

interface PackedCatalog {
  version: number;
  maxUncompressedBytes: number;
  coins: readonly unknown[];
}

/** Decode one complete source record at a time without keeping inflate buffers. */
export function decodeWorkerStablecoinCatalog(asset: PackedCatalog): readonly StablecoinMeta[] {
  if (asset.version !== 1 || !Number.isSafeInteger(asset.maxUncompressedBytes)
    || asset.maxUncompressedBytes <= 0) {
    throw new Error("Invalid packed stablecoin catalog manifest");
  }
  const output = new Uint8Array(asset.maxUncompressedBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const ids = new Set<string>();
  return asset.coins.map((coin) => {
    if (!Array.isArray(coin) || coin.length !== 3) throw new Error("Invalid packed stablecoin record");
    const [id, bytes, payload] = coin;
    if (typeof id !== "string" || !id || ids.has(id) || typeof bytes !== "number"
      || typeof payload !== "string" || !Number.isSafeInteger(bytes) || bytes <= 0
      || bytes > output.length) {
      throw new Error(`Invalid packed stablecoin record: ${id}`);
    }
    const compressed = Buffer.from(payload, "base64");
    // Gzip's ISIZE is the exact uncompressed byte count for these bounded records.
    if (compressed.length < 18 || compressed.readUInt32LE(compressed.length - 4) !== bytes) {
      throw new Error(`Packed stablecoin length mismatch: ${id}`);
    }
    const inflated = gunzipSync(compressed, output.subarray(0, bytes));
    const record = JSON.parse(decoder.decode(inflated)) as StablecoinMeta;
    if (record.id !== id) throw new Error(`Packed stablecoin identity mismatch: ${id}`);
    ids.add(id);
    return record;
  });
}

export default decodeWorkerStablecoinCatalog(packedAsset);
