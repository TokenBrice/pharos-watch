import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import type { EditorialFinding } from "@shared/lib/editorial-style";

import { EDITORIAL_BASELINE_PATH, EDITORIAL_EXCEPTIONS_PATH } from "./editorial-surface-registry";

export interface EditorialBaselineEntry {
  readonly surface: string;
  readonly record: string;
  readonly field: string;
  readonly rule: string;
  readonly count: number;
  readonly fingerprints: readonly string[];
}

export interface EditorialBaselineFile {
  readonly version: 1;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly generatedAt: string;
  readonly entries: readonly EditorialBaselineEntry[];
}

export interface EditorialException {
  readonly surface: string;
  readonly record: string;
  readonly field: string;
  readonly ruleId: string;
  readonly reason: string;
  readonly owner: string;
  /** Optional exact finding excerpt when one field contains multiple matches. */
  readonly excerpt?: string;
  /** Number of matching occurrences this selector is allowed to retain. */
  readonly occurrences?: number;
  readonly expiresAt?: string;
  readonly permanent?: boolean;
}

export interface EditorialExceptionFile {
  readonly version: 1;
  readonly exceptions: readonly EditorialException[];
}

export interface EditorialObservation {
  readonly surface: string;
  readonly record: string;
  readonly field: string;
  readonly rule: string;
  readonly excerpt: string;
  readonly context?: string;
  readonly finding?: EditorialFinding;
  readonly path?: string;
  readonly line?: number;
}

export interface EditorialBaselineRegression {
  readonly key: string;
  readonly message: string;
  readonly observation?: EditorialObservation;
}

export const EDITORIAL_BASELINE_SCHEMA_VERSION = 1 as const;
export const EDITORIAL_BASELINE_FILE = EDITORIAL_BASELINE_PATH;
export const EDITORIAL_EXCEPTION_FILE = EDITORIAL_EXCEPTIONS_PATH;

export function editorialBaselineKey(
  value: Pick<EditorialBaselineEntry, "surface" | "record" | "field" | "rule">,
): string {
  return [value.surface, value.record, value.field, value.rule].join("\u001f");
}

function normalizeFingerprintText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Hashes the offending excerpt with only the source line's minimal context. */
export function fingerprintEditorialObservation(observation: EditorialObservation): string {
  const normalized = [observation.rule, observation.excerpt, observation.context ?? ""]
    .map(normalizeFingerprintText)
    .join("\u001f");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function observationToEntry(observations: readonly EditorialObservation[]): EditorialBaselineEntry[] {
  const grouped = new Map<string, { entry: EditorialBaselineEntry; fingerprints: string[] }>();
  for (const observation of observations) {
    const key = editorialBaselineKey(observation);
    const fingerprint = fingerprintEditorialObservation(observation);
    const existing = grouped.get(key);
    if (existing) {
      existing.entry = { ...existing.entry, count: existing.entry.count + 1 };
      existing.fingerprints.push(fingerprint);
    } else {
      grouped.set(key, {
        entry: {
          surface: observation.surface,
          record: observation.record,
          field: observation.field,
          rule: observation.rule,
          count: 1,
          fingerprints: [],
        },
        fingerprints: [fingerprint],
      });
    }
  }
  return [...grouped.values()]
    .map(({ entry, fingerprints }) => ({ ...entry, fingerprints: [...fingerprints].sort() }))
    .sort((left, right) => editorialBaselineKey(left).localeCompare(editorialBaselineKey(right)));
}

export function buildEditorialBaseline(
  observations: readonly EditorialObservation[],
  { policyVersion, policyHash, generatedAt = new Date().toISOString() }: {
    policyVersion: string;
    policyHash: string;
    generatedAt?: string;
  },
): EditorialBaselineFile {
  return {
    version: EDITORIAL_BASELINE_SCHEMA_VERSION,
    policyVersion,
    policyHash,
    generatedAt,
    entries: observationToEntry(observations),
  };
}

function assertBaselineFile(value: unknown): asserts value is EditorialBaselineFile {
  if (!value || typeof value !== "object") throw new Error("[editorial-style] Editorial baseline must be an object.");
  const candidate = value as Partial<EditorialBaselineFile>;
  if (candidate.version !== EDITORIAL_BASELINE_SCHEMA_VERSION) {
    throw new Error(`[editorial-style] Unsupported editorial baseline version: ${String(candidate.version)}.`);
  }
  if (!Array.isArray(candidate.entries)) throw new Error("[editorial-style] Editorial baseline entries must be an array.");
}

export function readEditorialBaseline(path = EDITORIAL_BASELINE_FILE): EditorialBaselineFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`[editorial-style] Cannot read editorial baseline ${path}: ${(error as Error).message}`);
  }
  assertBaselineFile(parsed);
  return parsed;
}

export function writeEditorialBaseline(path: string, baseline: EditorialBaselineFile): void {
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

function assertExceptionFile(value: unknown): asserts value is EditorialExceptionFile {
  if (!value || typeof value !== "object") throw new Error("[editorial-style] Editorial exceptions must be an object.");
  const candidate = value as Partial<EditorialExceptionFile>;
  if (candidate.version !== EDITORIAL_BASELINE_SCHEMA_VERSION) {
    throw new Error(`[editorial-style] Unsupported editorial exception version: ${String(candidate.version)}.`);
  }
  if (!Array.isArray(candidate.exceptions)) {
    throw new Error("[editorial-style] Editorial exceptions must contain an exceptions array.");
  }
}

export function readEditorialExceptions(path = EDITORIAL_EXCEPTION_FILE): EditorialExceptionFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`[editorial-style] Cannot read editorial exceptions ${path}: ${(error as Error).message}`);
  }
  assertExceptionFile(parsed);
  return parsed;
}

function exceptionBaseKey(exception: EditorialException): string {
  return editorialBaselineKey({
    surface: exception.surface,
    record: exception.record,
    field: exception.field,
    rule: exception.ruleId,
  });
}

function exceptionKey(exception: EditorialException): string {
  const base = exceptionBaseKey(exception);
  return exception.excerpt === undefined ? base : `${base}\u001f${exception.excerpt}`;
}

function validFutureExpiry(expiresAt: string, now: Date): boolean {
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed > now.getTime();
}

export function validateEditorialExceptions(
  exceptions: readonly EditorialException[],
  knownFindingKeys: ReadonlySet<string>,
  { now = new Date() }: { now?: Date } = {},
): void {
  const seen = new Set<string>();
  for (const exception of exceptions) {
    const key = exceptionKey(exception);
    if (seen.has(key)) throw new Error(`[editorial-style] Duplicate exception entry: ${key}.`);
    seen.add(key);
    if (!exception.surface || !exception.record || !exception.field || !exception.ruleId) {
      throw new Error(`[editorial-style] Exception ${key} has an incomplete selector.`);
    }
    if (exception.excerpt !== undefined && !exception.excerpt.trim()) {
      throw new Error(`[editorial-style] Exception ${key} excerpt must be non-empty when provided.`);
    }
    if (!exception.reason.trim() || !exception.owner.trim()) {
      throw new Error(`[editorial-style] Exception ${key} needs a reason and owner.`);
    }
    if (exception.occurrences !== undefined && (!Number.isInteger(exception.occurrences) || exception.occurrences < 1)) {
      throw new Error(`[editorial-style] Exception ${key} occurrences must be a positive integer.`);
    }
    if (exception.permanent) {
      if (exception.expiresAt !== undefined) {
        throw new Error(`[editorial-style] Permanent exception ${key} must not carry expiresAt.`);
      }
    } else if (!exception.expiresAt || !validFutureExpiry(exception.expiresAt, now)) {
      throw new Error(`[editorial-style] Exception ${key} is expired or missing a future expiresAt.`);
    }
    if (!knownFindingKeys.has(exceptionBaseKey(exception))) {
      throw new Error(`[editorial-style] Orphaned exception entry: ${key}.`);
    }
  }
}
/**
 * Consumes the configured number of occurrences for a selector. A field-level
 * allowance defaults to one occurrence and cannot silently authorize a second.
 */
export function applyEditorialExceptions(
  observations: readonly EditorialObservation[],
  exceptions: readonly EditorialException[],
): EditorialObservation[] {
  const available = new Map<string, number>();
  for (const exception of exceptions) {
    const key = exceptionKey(exception);
    available.set(key, (available.get(key) ?? 0) + (exception.occurrences ?? 1));
  }
  return observations.filter((observation) => {
    const baseKey = editorialBaselineKey(observation);
    const excerptKey = `${baseKey}\u001f${observation.excerpt}`;
    const key = available.has(excerptKey) ? excerptKey : baseKey;
    const remaining = available.get(key) ?? 0;
    if (remaining <= 0) return true;
    available.set(key, remaining - 1);
    return false;
  });
}

function multiset(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

export function compareEditorialBaseline(
  observations: readonly EditorialObservation[],
  baseline: EditorialBaselineFile,
): EditorialBaselineRegression[] {
  const current = observationToEntry(observations);
  const previousByKey = new Map(baseline.entries.map((entry) => [editorialBaselineKey(entry), entry]));
  const regressions: EditorialBaselineRegression[] = [];
  for (const entry of current) {
    const key = editorialBaselineKey(entry);
    const previous = previousByKey.get(key);
    if (!previous) {
      regressions.push({
        key,
        message: `New editorial violation ${key}: ${entry.count} occurrence(s).`,
      });
      continue;
    }
    if (entry.count > previous.count) {
      regressions.push({
        key,
        message: `Editorial violation count increased for ${key}: ${previous.count} -> ${entry.count}.`,
      });
    }
    const oldFingerprints = multiset(previous.fingerprints);
    for (const fingerprint of entry.fingerprints) {
      const remaining = oldFingerprints.get(fingerprint) ?? 0;
      if (remaining > 0) oldFingerprints.set(fingerprint, remaining - 1);
      else {
        regressions.push({ key, message: `New editorial fingerprint for ${key}: ${fingerprint}.` });
        break;
      }
    }
  }
  return regressions;
}
