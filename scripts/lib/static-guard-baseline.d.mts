export type StaticGuardId =
  | "g1-fail-open-reads"
  | "g2-freshness-clock-hygiene"
  | "g3-sql-d1-safety";

export type GuardBaselineMap = Record<string, Record<string, number>>;

export interface StaticGuardBaselineDocument {
  schemaVersion: 1;
  guards: Record<StaticGuardId, GuardBaselineMap>;
}

export interface StaleBaselineViolation {
  file: string;
  line: number;
  rule: "stale-baseline";
  text: string;
}

export const STATIC_GUARD_BASELINE_PATH: string;
export const STATIC_GUARD_IDS: readonly StaticGuardId[];

export function normalizeBaselineFilePath(filePath: string): string;
export function getStaticGuardBaselineDigest(cwd?: string): string;
export function hasStaticGuardBaselineEntry(filePath: string, cwd?: string): boolean;
export function validateStaticGuardBaselineDocument(raw: unknown, label?: string): StaticGuardBaselineDocument;
export function loadStaticGuardBaselines(
  cwd?: string,
  options?: { required?: boolean },
): StaticGuardBaselineDocument;
export function getFileBaselineRules(
  guardId: StaticGuardId,
  relPath: string,
  cwd?: string,
  options?: { required?: boolean },
): Record<string, number>;
export function applyGuardBaselineToViolations<T extends { file: string; line: number; rule: string; text: string }>(
  guardId: StaticGuardId,
  violations: readonly T[],
  options?: {
    cwd?: string;
    baseline?: GuardBaselineMap;
    coveredRoots?: readonly string[];
    checkStale?: boolean;
    required?: boolean;
  },
): { violations: T[]; stale: StaleBaselineViolation[] };
export function compareBaselineRatchet(
  baseDoc: StaticGuardBaselineDocument,
  currentDoc: StaticGuardBaselineDocument,
): string[];
export function verifyStaticGuardBaselineRatchet(options?: {
  cwd?: string;
  baseRef?: string;
  required?: boolean;
  execGit?: (args: string[], cwd: string) => string;
}): string[];
