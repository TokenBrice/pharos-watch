import { Buffer } from "node:buffer";
import { gunzipSync } from "fflate";
import packedAsset from "@shared/data/stablecoins/coins.worker-full.generated.json";
import type { StablecoinMeta } from "@shared/types/core";

// Workers' ambient Buffer declaration is untyped; retain the native byte decoder.
const nativeBuffer = Buffer as {
  from(value: string, encoding: "base64"): Uint8Array & { readUInt32LE(offset: number): number };
};

interface PackedCatalog {
  version: number;
  maxUncompressedBytes: number;
  coins: readonly unknown[];
}

function isValidBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 61) {
      if (index < value.length - 2
        || (index === value.length - 2 && value.charCodeAt(value.length - 1) !== 61)) return false;
      continue;
    }
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 43 || code === 47) continue;
    return false;
  }
  return true;
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
    const [id, bytes, payload] = coin as unknown[];
    if (typeof id !== "string" || !id || ids.has(id) || typeof bytes !== "number"
      || typeof payload !== "string" || !Number.isSafeInteger(bytes) || bytes <= 0
      || bytes > output.length) {
      throw new Error(`Invalid packed stablecoin record: ${id}`);
    }
    if (!isValidBase64(payload)) {
      throw new Error(`Invalid packed stablecoin base64: ${id}`);
    }
    const compressed = nativeBuffer.from(payload, "base64");
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
