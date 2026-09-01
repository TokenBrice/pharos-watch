import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import type { EditorialFinding, EditorialSeverity } from "@shared/lib/editorial-style";

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
  /** Diagnostic assertion for the exact finding excerpt. */
  readonly excerpt?: string;
  /** Exact observation fingerprints this exception suppresses. Duplicates represent repeated occurrences. */
  readonly fingerprints: readonly string[];
  /** Must equal fingerprints.length when retained for human-readable allowance counts. */
  readonly occurrences?: number;
  readonly expiresAt?: string;
  readonly permanent?: boolean;
  readonly reviewedAt?: string;
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
  readonly kind: "new" | "stale";
  readonly key: string;
  readonly fingerprint?: string;
  readonly severity?: Exclude<EditorialSeverity, "off">;
  readonly blocking: boolean;
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

/** Hashes the offending excerpt with the collector's bounded, occurrence-local context. */
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
  { policyVersion, policyHash, generatedAt, previousBaseline }: {
    policyVersion: string;
    policyHash: string;
    generatedAt?: string;
    previousBaseline?: EditorialBaselineFile;
  },
): EditorialBaselineFile {
  const entries = observationToEntry(observations);
  const semanticStateMatches = previousBaseline !== undefined
    && previousBaseline.policyVersion === policyVersion
    && previousBaseline.policyHash === policyHash
    && JSON.stringify(previousBaseline.entries) === JSON.stringify(entries);
  return {
    version: EDITORIAL_BASELINE_SCHEMA_VERSION,
    policyVersion,
    policyHash,
    generatedAt: generatedAt ?? (semanticStateMatches ? previousBaseline.generatedAt : new Date().toISOString()),
    entries,
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
  const allowedFileFields = new Set(["version", "exceptions"]);
  for (const field of Object.keys(value)) {
    if (!allowedFileFields.has(field)) throw new Error(`[editorial-style] Unknown editorial exception file field "${field}".`);
  }
  const allowedEntryFields = new Set([
    "surface", "record", "field", "ruleId", "excerpt", "fingerprints", "occurrences",
    "reason", "owner", "expiresAt", "permanent", "reviewedAt",
  ]);
  candidate.exceptions.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`[editorial-style] Exception entry ${index} must be an object.`);
    }
    for (const field of Object.keys(entry)) {
      if (!allowedEntryFields.has(field)) {
        throw new Error(`[editorial-style] Unknown field "${field}" in exception entry ${index}.`);
      }
    }
    const exception = entry as Record<string, unknown>;
    for (const field of ["surface", "record", "field", "ruleId", "reason", "owner"] as const) {
      if (typeof exception[field] !== "string") {
        throw new Error(`[editorial-style] Exception entry ${index} field "${field}" must be a string.`);
      }
    }
    if (!Array.isArray(exception.fingerprints) || exception.fingerprints.some((fingerprint) => typeof fingerprint !== "string")) {
      throw new Error(`[editorial-style] Exception entry ${index} fingerprints must be an array of strings.`);
    }
    if (exception.excerpt !== undefined && typeof exception.excerpt !== "string") {
      throw new Error(`[editorial-style] Exception entry ${index} excerpt must be a string.`);
    }
    if (exception.occurrences !== undefined && typeof exception.occurrences !== "number") {
      throw new Error(`[editorial-style] Exception entry ${index} occurrences must be a number.`);
    }
    for (const field of ["expiresAt", "reviewedAt"] as const) {
      if (exception[field] !== undefined && typeof exception[field] !== "string") {
        throw new Error(`[editorial-style] Exception entry ${index} field "${field}" must be a string.`);
      }
    }
    if (exception.permanent !== undefined && typeof exception.permanent !== "boolean") {
      throw new Error(`[editorial-style] Exception entry ${index} permanent must be a boolean.`);
    }
    const selector = [exception.surface, exception.record, exception.field, exception.ruleId] as string[];
    if (
      selector.some((part) => !part.trim() || part.includes("\u001f"))
      || !/^[a-z0-9-]+$/.test(exception.surface as string)
      || !/^[a-z0-9-]+$/.test(exception.ruleId as string)
    ) {
      throw new Error(`[editorial-style] Exception entry ${index} has a malformed selector.`);
    }
    if (!(exception.reason as string).trim()) {
      throw new Error(`[editorial-style] Exception entry ${index} needs a non-empty reason.`);
    }
    if (!(exception.owner as string).trim()) {
      throw new Error(`[editorial-style] Exception entry ${index} needs a non-empty owner.`);
    }
    if (exception.excerpt !== undefined && !(exception.excerpt as string).trim()) {
      throw new Error(`[editorial-style] Exception entry ${index} excerpt must be non-empty when provided.`);
    }
    const fingerprints = exception.fingerprints as string[];
    if (fingerprints.length === 0 || fingerprints.some((fingerprint) => !/^[a-f0-9]{16}$/.test(fingerprint))) {
      throw new Error(`[editorial-style] Exception entry ${index} has a malformed fingerprint.`);
    }
    if (
      exception.occurrences !== undefined
      && (!Number.isInteger(exception.occurrences) || exception.occurrences < 1 || exception.occurrences !== fingerprints.length)
    ) {
      throw new Error(`[editorial-style] Exception entry ${index} occurrences must be positive and equal fingerprints.length.`);
    }
    for (const field of ["expiresAt", "reviewedAt"] as const) {
      if (exception[field] !== undefined && !Number.isFinite(Date.parse(exception[field] as string))) {
        throw new Error(`[editorial-style] Exception entry ${index} field "${field}" must be an ISO date.`);
      }
    }
    if (exception.permanent === true && exception.expiresAt !== undefined) {
      throw new Error(`[editorial-style] Permanent exception entry ${index} must not carry expiresAt.`);
    }
  });
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

function validFutureExpiry(expiresAt: string, now: Date): boolean {
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed > now.getTime();
}

export function validateEditorialExceptions(
  exceptions: readonly EditorialException[],
  knownFindingKeys: ReadonlySet<string>,
  {
    now = new Date(),
    knownRuleIds,
    knownSurfaceIds,
  }: {
    now?: Date;
    knownRuleIds?: ReadonlySet<string>;
    knownSurfaceIds?: ReadonlySet<string>;
  } = {},
): void {
  const seen = new Set<string>();
  for (const exception of exceptions) {
    const key = exceptionBaseKey(exception);
    if (seen.has(key)) throw new Error(`[editorial-style] Duplicate exception entry: ${key}.`);
    seen.add(key);
    if (
      !exception.surface.trim() || !exception.record.trim() || !exception.field.trim() || !exception.ruleId.trim()
      || [exception.surface, exception.record, exception.field, exception.ruleId].some((part) => part.includes("\u001f"))
      || !/^[a-z0-9-]+$/.test(exception.surface)
      || !/^[a-z0-9-]+$/.test(exception.ruleId)
    ) {
      throw new Error(`[editorial-style] Exception ${key} has an incomplete selector.`);
    }
    if (knownSurfaceIds && !knownSurfaceIds.has(exception.surface)) {
      throw new Error(`[editorial-style] Exception ${key} names unknown surface id "${exception.surface}".`);
    }
    if (knownRuleIds && !knownRuleIds.has(exception.ruleId)) {
      throw new Error(`[editorial-style] Exception ${key} names unknown rule id "${exception.ruleId}".`);
    }
    if (exception.excerpt !== undefined && !exception.excerpt.trim()) {
      throw new Error(`[editorial-style] Exception ${key} excerpt must be non-empty when provided.`);
    }
    if (!exception.reason.trim()) {
      throw new Error(`[editorial-style] Exception ${key} needs a non-empty reason.`);
    }
    if (!exception.owner.trim()) {
      throw new Error(`[editorial-style] Exception ${key} needs a non-empty owner.`);
    }
    if (exception.fingerprints.length === 0 || exception.fingerprints.some((fingerprint) => !/^[a-f0-9]{16}$/.test(fingerprint))) {
      throw new Error(`[editorial-style] Exception ${key} has a malformed fingerprint; expected 16 lowercase hexadecimal characters.`);
    }
    if (exception.occurrences !== undefined && (!Number.isInteger(exception.occurrences) || exception.occurrences < 1)) {
      throw new Error(`[editorial-style] Exception ${key} occurrences must be a positive integer.`);
    }
    if (exception.occurrences !== undefined && exception.occurrences !== exception.fingerprints.length) {
      throw new Error(`[editorial-style] Exception ${key} occurrences must equal fingerprints.length.`);
    }
    if (exception.reviewedAt !== undefined && !Number.isFinite(Date.parse(exception.reviewedAt))) {
      throw new Error(`[editorial-style] Exception ${key} reviewedAt must be an ISO date.`);
    }
    if (exception.permanent) {
      if (exception.expiresAt !== undefined) {
        throw new Error(`[editorial-style] Permanent exception ${key} must not carry expiresAt.`);
      }
    } else if (!exception.expiresAt || !validFutureExpiry(exception.expiresAt, now)) {
      throw new Error(`[editorial-style] Exception ${key} is expired or missing a future expiresAt.`);
    }
    if (!knownFindingKeys.has(exceptionBaseKey(exception))) {
      throw new Error(`[editorial-style] Orphaned exception entry matches no current selector: ${key}.`);
    }
  }
}
/**
 * Consumes only fingerprint-exact occurrences. Every configured allowance must
 * be consumed, so reordered or repaired prose cannot leave reusable exemptions.
 */
export function applyEditorialExceptions<T extends EditorialObservation>(
  observations: readonly T[],
  exceptions: readonly EditorialException[],
): T[] {
  const states = exceptions.map((exception) => ({
    exception,
    initial: exception.fingerprints.length,
    remaining: exception.fingerprints.length,
  }));
  const available = new Map<string, { state: (typeof states)[number]; remaining: number }>();
  for (const state of states) {
    const { exception } = state;
    const base = exceptionBaseKey(exception);
    for (const fingerprint of exception.fingerprints) {
      const key = `${base}\u001f${fingerprint}`;
      const existing = available.get(key);
      if (existing) {
        existing.remaining += 1;
      } else {
        available.set(key, { state, remaining: 1 });
      }
    }
  }
  const remainingObservations = observations.filter((observation) => {
    const baseKey = editorialBaselineKey(observation);
    const fingerprint = fingerprintEditorialObservation(observation);
    const key = `${baseKey}\u001f${fingerprint}`;
    const allowance = available.get(key);
    if (
      !allowance || allowance.remaining <= 0
      || (allowance.state.exception.excerpt !== undefined && allowance.state.exception.excerpt !== observation.excerpt)
    ) {
      return true;
    }
    allowance.remaining -= 1;
    allowance.state.remaining -= 1;
    return false;
  });
  for (const state of states) {
    if (state.remaining === 0) continue;
    const key = exceptionBaseKey(state.exception);
    const consumed = state.initial - state.remaining;
    const message = consumed === 0 ? "matches nothing" : "was only partially consumed";
    throw new Error(
      `[editorial-style] Exception allowance ${key} ${message}: consumed ${consumed} of ${state.initial} exact fingerprint occurrence(s).`,
    );
  }
  return remainingObservations;
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
  const observationByFingerprint = new Map<string, EditorialObservation>();
  for (const observation of observations) {
    observationByFingerprint.set(
      `${editorialBaselineKey(observation)}\u001f${fingerprintEditorialObservation(observation)}`,
      observation,
    );
  }
  for (const entry of current) {
    const key = editorialBaselineKey(entry);
    const previous = previousByKey.get(key);
    const oldFingerprints = multiset(previous?.fingerprints ?? []);
    for (const fingerprint of entry.fingerprints) {
      const remaining = oldFingerprints.get(fingerprint) ?? 0;
      if (remaining > 0) oldFingerprints.set(fingerprint, remaining - 1);
      else {
        const observation = observationByFingerprint.get(`${key}\u001f${fingerprint}`);
        const severity = observation?.finding?.severity;
        regressions.push({
          kind: "new",
          key,
          fingerprint,
          severity,
          blocking: severity !== "advisory",
          observation,
          message: `New editorial fingerprint for ${key}: ${fingerprint} (${severity ?? "unknown"} severity).`,
        });
      }
    }
    for (const [fingerprint, remaining] of oldFingerprints) {
      for (let index = 0; index < remaining; index += 1) {
        regressions.push({
          kind: "stale",
          key,
          fingerprint,
          blocking: true,
          message: `Stale editorial baseline fingerprint for ${key}: ${fingerprint}. Regenerate with npm run generate:editorial-baseline.`,
        });
      }
    }
    previousByKey.delete(key);
  }
  for (const [key, previous] of previousByKey) {
    for (const fingerprint of previous.fingerprints) {
      regressions.push({
        kind: "stale",
        key,
        fingerprint,
        blocking: true,
        message: `Stale editorial baseline fingerprint for ${key}: ${fingerprint}. Regenerate with npm run generate:editorial-baseline.`,
      });
    }
  }
  return regressions;
}
