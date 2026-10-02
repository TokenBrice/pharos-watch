import type { z } from "zod";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import { isRecord } from "@shared/lib/type-guards";

type AttributedRow = { assetId: string; [key: string]: unknown };
const EMPTY_REGISTRY_ROWS: readonly never[] = [];

export class ReviewedRegistryEntryError extends Error {
  constructor(readonly path: string, message: string) {
    super(message);
    this.name = "ReviewedRegistryEntryError";
  }
}

/** Index only attribution and key collisions; evidence is admitted on the asset's first read. */
export function createReviewedAssetRegistry<T>(args: {
  rows: readonly AttributedRow[];
  schema: z.ZodType<T>;
  path: string;
  keyOf?: (row: AttributedRow) => string | undefined;
  keyPath?: string;
}) {
  const byAsset = new Map<string, { row: AttributedRow; index: number }[]>();
  const keyOwners = new Map<string, { assetId: string; index: number }>();
  const duplicates = new Map<string, ReviewedRegistryEntryError>();
  const validated = new Map<string, readonly T[]>();
  args.rows.forEach((row, index) => {
    const rows = byAsset.get(row.assetId) ?? [];
    rows.push({ row, index });
    byAsset.set(row.assetId, rows);
    const key = args.keyOf ? args.keyOf(row) : row.assetId;
    if (key === undefined) return;
    const owner = keyOwners.get(key);
    if (owner) {
      const message = `Duplicate reviewed registry key: ${key}`;
      duplicates.set(owner.assetId, new ReviewedRegistryEntryError(`${args.path}.${owner.index}.${args.keyPath ?? "assetId"}`, message));
      duplicates.set(row.assetId, new ReviewedRegistryEntryError(`${args.path}.${index}.${args.keyPath ?? "assetId"}`, message));
    } else {
      keyOwners.set(key, { assetId: row.assetId, index });
    }
  });
  function getAll(assetId: string): readonly T[] {
    const duplicate = duplicates.get(assetId);
    if (duplicate) throw duplicate;
    const cached = validated.get(assetId);
    if (cached) return cached;
    const authored = byAsset.get(assetId);
    if (!authored) return EMPTY_REGISTRY_ROWS;
    const rows = authored.map(({ row, index }) => {
      const parsed = args.schema.safeParse(row);
      if (!parsed.success) {
        const issue = parsed.error.issues[0]!;
        const path = [args.path, index, ...issue.path].join(".");
        throw new ReviewedRegistryEntryError(path, parsed.error.issues.map((failure) => `${[args.path, index, ...failure.path].join(".")}: ${failure.message}`).join("; "));
      }
      return parsed.data;
    });
    validated.set(assetId, rows);
    return rows;
  }
  return { getAll, get: (assetId: string): T | undefined => getAll(assetId)[0] };
}

/** Preserve historical schema transforms in full-file digests without validating evidence. */
export function canonicalizeReviewedRegistryDigest(
  value: unknown,
  arrayKeys: Readonly<Record<string, (row: unknown) => string>>,
  defaults: Readonly<Record<string, unknown>> = {},
  trimmedTextPaths: readonly string[] = [],
  path = "",
): unknown {
  if (Array.isArray(value)) {
    const rows = value.map((row) => canonicalizeReviewedRegistryDigest(row, arrayKeys, defaults, trimmedTextPaths, `${path}.*`));
    const keyOf = arrayKeys[path];
    return keyOf ? rows.sort((a, b) => compareText(keyOf(a), keyOf(b))) : rows;
  }
  if (typeof value === "string" && trimmedTextPaths.includes(path)) return value.trim();
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, row] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    result[key] = canonicalizeReviewedRegistryDigest(row, arrayKeys, defaults, trimmedTextPaths, childPath);
  }
  for (const [defaultPath, fallback] of Object.entries(defaults)) {
    const prefix = path ? `${path}.` : "";
    if (defaultPath.startsWith(prefix)) {
      const key = defaultPath.slice(prefix.length);
      if (!key.includes(".") && result[key] === undefined) result[key] = fallback;
    }
  }
  return result;
}

export function reviewedRegistryDigestKey(field: string) {
  return (value: unknown): string => isRecord(value) && typeof value[field] === "string" ? value[field] : "";
}
