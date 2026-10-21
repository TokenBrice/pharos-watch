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

function unpackBytes(bytes: unknown, payload: unknown, maximum: number, id: string): Uint8Array {
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0
    || bytes > maximum || typeof payload !== "string") {
    throw new Error(`Invalid packed stablecoin record: ${id}`);
  }
  if (!isValidBase64(payload)) throw new Error(`Invalid packed stablecoin base64: ${id}`);
  const compressed = nativeBuffer.from(payload, "base64");
  if (compressed.length < 18 || compressed.readUInt32LE(compressed.length - 4) !== bytes) {
    throw new Error(`Packed stablecoin length mismatch: ${id}`);
  }
  return compressed;
}

function lazyEvidence(compressed: Uint8Array, bytes: number, decoder: TextDecoder): () => unknown {
  // A separate closure scope must not retain the catalog's interning table or
  // reusable inflate buffer after initialization.
  return () => JSON.parse(decoder.decode(gunzipSync(compressed, new Uint8Array(bytes))));
}

/** Decode one complete source record at a time without keeping inflate buffers. */
export function decodeWorkerStablecoinCatalog(asset: PackedCatalog): readonly StablecoinMeta[] {
  if (asset.version !== 2 || !Number.isSafeInteger(asset.maxUncompressedBytes)
    || asset.maxUncompressedBytes <= 0 || asset.coins.length === 0) {
    throw new Error("Invalid packed stablecoin catalog manifest");
  }
  const output = new Uint8Array(asset.maxUncompressedBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const ids = new Set<string>();
  // JSON.parse does not share repeated source text across independently inflated
  // records. Intern immutable strings only; never alias mutable evidence objects.
  // This table dies after initialization, leaving only strings the catalog uses.
  const strings = new Map<string, string>();
  function internStrings(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const field = record[key];
      if (typeof field === "string") {
        const existing = strings.get(field);
        if (existing !== undefined) record[key] = existing;
        else strings.set(field, field);
      } else internStrings(field);
    }
  }
  return asset.coins.map((coin) => {
    if (!Array.isArray(coin) || (coin.length !== 3 && coin.length !== 4)) throw new Error("Invalid packed stablecoin record");
    const [id, bytes, payload, packedEvidence] = coin as unknown[];
    if (typeof id !== "string" || !id || ids.has(id)) throw new Error(`Invalid packed stablecoin record: ${id}`);
    const compressed = unpackBytes(bytes, payload, output.length, id);
    const inflated = gunzipSync(compressed, output.subarray(0, bytes as number));
    const record = JSON.parse(decoder.decode(inflated)) as StablecoinMeta;
    if (record.id !== id) throw new Error(`Packed stablecoin identity mismatch: ${id}`);
    internStrings(record);
    if (packedEvidence !== undefined) {
      if (packedEvidence === null || typeof packedEvidence !== "object" || Array.isArray(packedEvidence)) {
        throw new Error(`Invalid packed stablecoin evidence: ${id}`);
      }
      for (const [field, packed] of Object.entries(packedEvidence)) {
        if ((field !== "blacklistabilityReview" && field !== "mintAuthority"
            && field !== "bridgeRouteRisk" && field !== "oracleRisk" && field !== "genius")
          || record[field] !== null || !Array.isArray(packed) || packed.length !== 2) {
          throw new Error(`Invalid packed stablecoin evidence: ${id}`);
        }
        const [evidenceBytes, evidencePayload] = packed as unknown[];
        // Keep compressed bytes only; complete reviewed fields are decoded on
        // demand and can be collected after their source-specific hashes form.
        const evidence = unpackBytes(evidenceBytes, evidencePayload, output.length, id);
        Object.defineProperty(record, field, {
          enumerable: true,
          configurable: true,
          get: lazyEvidence(evidence, evidenceBytes as number, decoder),
        });
      }
    }
    ids.add(id);
    return record;
  });
}

export default decodeWorkerStablecoinCatalog(packedAsset);
