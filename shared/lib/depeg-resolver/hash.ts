import { sha256Hex } from "../sha256";

export const DDR_HASH_DOMAINS = {
  publicPrediction: "ddr.public_prediction.prediction.v1",
  publicNoCall: "ddr.public_prediction.no_call.v1",
  publicationManifest: "ddr.publication_manifest.v1",
  publicPredictionIds: "ddr.public_prediction_ids.v1",
  ddrrReviewSnapshot: "ddrr.review_snapshot.v2",
} as const;

export type DdrHashDomain = (typeof DDR_HASH_DOMAINS)[keyof typeof DDR_HASH_DOMAINS];

function assertPlainHashValue(value: unknown, path: string): void {
  if (value === null) return;
  if (value === undefined) return;

  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return;
  if (valueType === "number") {
    const numberValue = value as number;
    if (!Number.isFinite(numberValue) || Math.abs(numberValue) > Number.MAX_SAFE_INTEGER) {
      throw new TypeError(`Cannot hash non-finite or unsafe number at ${path}`);
    }
    return;
  }
  if (valueType === "bigint" || valueType === "function" || valueType === "symbol") {
    throw new TypeError(`Cannot hash ${valueType} at ${path}`);
  }

  if (value instanceof Date) {
    throw new TypeError(`Cannot hash Date at ${path}; convert it first`);
  }
  if (value instanceof Map || value instanceof Set) {
    throw new TypeError(`Cannot hash Map/Set at ${path}; convert it first`);
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new TypeError(`Cannot hash binary data at ${path}; convert it first`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      if (entry === undefined) {
        throw new TypeError(`Cannot hash undefined array entry at ${path}[${index}]`);
      }
      assertPlainHashValue(entry, `${path}[${index}]`);
    });
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`Cannot hash non-plain object at ${path}`);
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    assertPlainHashValue(entry, `${path}.${key}`);
  }
}

function stringifyCanonical(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stringifyCanonical(entry)).join(",")}]`;
  }

  const objectValue = value as Record<string, unknown>;
  const entries = Object.keys(objectValue)
    .filter((key) => objectValue[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stringifyCanonical(objectValue[key])}`);
  return `{${entries.join(",")}}`;
}

export function stableJsonStringifyV1(value: unknown): string {
  assertPlainHashValue(value, "$");
  return stringifyCanonical(value);
}

export function stableJsonHashV1(domain: string, payload: unknown): string {
  if (!Object.values(DDR_HASH_DOMAINS).includes(domain as DdrHashDomain)) {
    throw new Error(`Unsupported DDR hash domain: ${domain}`);
  }
  return sha256Hex(stableJsonStringifyV1({ domain, payload }));
}
