import type { z } from "zod";
import { compareText } from "./primitives";
import { isRecord } from "../type-guards";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";
import { deepFreeze } from "../../types/safety-score-v9-immutable";

type AttributedRow = { assetId: string; [key: string]: unknown };
const EMPTY_REGISTRY_ROWS: readonly never[] = [];

export class ReviewedRegistryEntryError extends Error {
  constructor(readonly path: string, message: string) {
    super(message);
    this.name = "ReviewedRegistryEntryError";
  }
}

/** File-local tables share exact observations, never the scope or outcome of a review. */
export function createReviewedRegistryReferenceExpander(
  tables: Readonly<Record<string, readonly { id: string; value: unknown }[]>>,
  path: string,
) {
  const indexes = Object.entries(tables).map(([field, entries]) => {
    deepFreeze(entries);
    const values = new Map<string, unknown>();
    const duplicates = new Set<string>();
    for (const entry of entries) {
      if (values.has(entry.id)) duplicates.add(entry.id);
      values.set(entry.id, entry.value);
    }
    return { field, values, duplicates };
  });
  return (row: AttributedRow, index = 0): AttributedRow => {
    const expanded = { ...row };
    for (const { field, values, duplicates } of indexes) {
      const refField = `${field}Refs`;
      if (field in row) {
        throw new ReviewedRegistryEntryError(`${path}.${index}.${field}`, "Authored observations require references, not inline values");
      }
      if (!(refField in row)) continue;
      const refs = row[refField];
      if (!Array.isArray(refs)) {
        throw new ReviewedRegistryEntryError(`${path}.${index}.${refField}`, "Observation references must be an array");
      }
      const seen = new Set<string>();
      expanded[field] = refs.map((ref: unknown, refIndex) => {
        const refPath = `${path}.${index}.${refField}.${refIndex}`;
        if (typeof ref !== "string" || !values.has(ref)) {
          throw new ReviewedRegistryEntryError(refPath, `Dangling observation reference: ${String(ref)}`);
        }
        if (duplicates.has(ref)) throw new ReviewedRegistryEntryError(refPath, `Duplicate observation reference: ${ref}`);
        if (seen.has(ref)) throw new ReviewedRegistryEntryError(refPath, `Duplicate observation reference: ${ref}`);
        seen.add(ref);
        return values.get(ref);
      });
      delete expanded[refField];
    }
    return expanded;
  };
}

function isObservationTable(table: unknown): table is { id: string; value: unknown }[] {
  return Array.isArray(table) && table.every((entry: unknown) =>
    isRecord(entry) && typeof entry.id === "string" && "value" in entry &&
    Object.keys(entry).every((key) => key === "id" || key === "value"));
}

/** Expand an authored envelope before its existing strict schema and digest boundary. */
export function expandReviewedRegistryReferences(
  value: Record<string, unknown>,
  rowKey: string,
  tableFields: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const expanded = { ...value };
  const tables: Record<string, { id: string; value: unknown }[]> = {};
  for (const [field, tableKey] of Object.entries(tableFields)) {
    const table = value[tableKey];
    if (!isObservationTable(table)) {
      throw new ReviewedRegistryEntryError(tableKey, "Expected an authored observation table");
    }
    const ids = new Set<string>();
    for (const [index, entry] of table.entries()) {
      if (ids.has(entry.id)) {
        throw new ReviewedRegistryEntryError(`${tableKey}.${index}.id`, `Duplicate observation reference: ${entry.id}`);
      }
      ids.add(entry.id);
    }
    tables[field] = table;
    delete expanded[tableKey];
  }
  const expand = createReviewedRegistryReferenceExpander(tables, rowKey);
  const rows = value[rowKey];
  if (!Array.isArray(rows) || rows.some((row) => !isRecord(row) || typeof row.assetId !== "string")) {
    throw new ReviewedRegistryEntryError(rowKey, "Expected attributed authored review rows");
  }
  expanded[rowKey] = rows.map(expand);
  return expanded;
}

/** Share unchanged JSON subtrees only after successful schema admission. */
function reuseAdmittedRegistryValue(authored: unknown, admitted: unknown): unknown {
  if (Object.is(authored, admitted)) return authored;
  if (authored === null || admitted === null || typeof authored !== "object" || typeof admitted !== "object") {
    return admitted;
  }
  if (Array.isArray(authored) || Array.isArray(admitted)) {
    if (!Array.isArray(authored) || !Array.isArray(admitted)) return admitted;
    let unchanged = authored.length === admitted.length;
    for (let index = 0; index < admitted.length; index++) {
      admitted[index] = reuseAdmittedRegistryValue(authored[index], admitted[index]);
      unchanged &&= Object.is(authored[index], admitted[index]);
    }
    return unchanged ? authored : admitted;
  }
  if (Object.getPrototypeOf(authored) !== Object.prototype || Object.getPrototypeOf(admitted) !== Object.prototype) {
    return admitted;
  }
  const source = authored as Record<string, unknown>;
  const result = admitted as Record<string, unknown>;
  const keys = Object.keys(result);
  let unchanged = Object.keys(source).length === keys.length;
  for (const key of keys) {
    result[key] = reuseAdmittedRegistryValue(source[key], result[key]);
    unchanged &&= Object.prototype.hasOwnProperty.call(source, key) && Object.is(source[key], result[key]);
  }
  return unchanged ? authored : admitted;
}

/**
 * Index only attribution and key collisions; evidence is admitted on the asset's first read.
 * Reuse schema-equivalent authored JSON subtrees irrespective of object-key insertion
 * order. Transformed/defaulted/stripped values retain the admitted graph, while their
 * unchanged children need not occupy a second isolate-lifetime graph.
 */
export function createReviewedAssetRegistry<T>(args: {
  rows: readonly AttributedRow[];
  schema: z.ZodType<T>;
  path: string;
  keyOf?: (row: AttributedRow) => string | undefined;
  keyPath?: string;
  expandRow?: (row: AttributedRow, index: number) => AttributedRow;
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
    const rows = authored.map(({ row: authoredRow, index }) => {
      const row = args.expandRow ? args.expandRow(authoredRow, index) : authoredRow;
      const parsed = args.schema.safeParse(row);
      if (!parsed.success) {
        const issue = parsed.error.issues[0]!;
        const path = [args.path, index, ...issue.path].join(".");
        throw new ReviewedRegistryEntryError(path, parsed.error.issues.map((failure) => `${[args.path, index, ...failure.path].join(".")}: ${failure.message}`).join("; "));
      }
      return reuseAdmittedRegistryValue(row, parsed.data) as T;
    });
    validated.set(assetId, rows);
    return rows;
  }
  return { getAll, get: (assetId: string): T | undefined => getAll(assetId)[0] };
}

export function reviewedRegistryEnvelopeDigest(domain: string, field: "payload" | "overlays", value: unknown): string {
  return sha256Hex(stableJsonStringifyV1({ domain, [field]: value }));
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
