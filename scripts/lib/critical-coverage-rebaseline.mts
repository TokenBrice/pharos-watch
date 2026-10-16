import type { BaseBlobExec } from "./critical-ownership.mts";

export const REBASELINE_DIRECTORY = ".ci/critical-coverage-rebaseline";
export const REBASELINE_MEASUREMENT_COMMAND = "CRITICAL_COVERAGE_RATCHET_ALL=1 npm run coverage:critical";

export interface CriticalCoverageRebaselineRecord {
  version: 1;
  waveId: string;
  baseSha: string;
  candidateSha: string;
  measurement: { command: string; baseLcovSha256: string; candidateLcovSha256: string; runUrl: string | null };
  approvedBy: string;
  reviewer: string;
  approvedAt: string;
  transitionExpiresAt: string;
  entries: Array<{
    source: string;
    previousFloor: number;
    measuredBefore: number;
    measuredAfter: number;
    newFloor: number;
    configuredLineMinimum: number;
    branchFloor: number | null;
    removedTests: Array<{ path: string; titles: string[] }>;
    survivingOwners: Array<{ path: string; title: string }>;
    protectedClass: string;
    rationale: string;
  }>;
}

interface RebaselineContext {
  previous: Record<string, number>;
  candidate: Record<string, number>;
  lineMinimum: (source: string) => number;
  branchMinimum: (source: string) => number | null;
  now?: Date;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function percentage(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function repoPath(value: unknown): value is string {
  return text(value) && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid critical coverage rebaseline: ${message}`);
}

export function parseRebaselineBaseline(raw: string): Record<string, number> {
  const decoded: unknown = JSON.parse(raw);
  requireValid(record(decoded), "comparison baseline must be a non-null record");
  const files = "files" in decoded ? decoded.files : decoded;
  requireValid(record(files), "comparison baseline files must be a non-null record");
  for (const [source, floor] of Object.entries(files)) {
    requireValid(percentage(floor), `${source}: comparison baseline must be a finite number between 0 and 100`);
  }
  return files as Record<string, number>;
}

export function decreasedCoverageSources(previous: Record<string, number>, candidate: Record<string, number>): string[] {
  return Object.keys(candidate).filter((source) => source in previous && candidate[source] < previous[source]).sort();
}

export function validateCriticalCoverageRebaseline(
  value: unknown,
  { previous, candidate, lineMinimum, branchMinimum, now = new Date() }: RebaselineContext,
): CriticalCoverageRebaselineRecord {
  requireValid(record(value) && value.version === 1, "record version must be 1");
  requireValid(text(value.waveId), "waveId is required");
  for (const key of ["baseSha", "candidateSha"] as const) {
    requireValid(typeof value[key] === "string" && /^[a-f0-9]{40}$/i.test(value[key]), `${key} must be a full commit SHA`);
  }
  for (const key of ["approvedBy", "reviewer"] as const) requireValid(text(value[key]), `${key} is required`);
  for (const key of ["approvedAt", "transitionExpiresAt"] as const) {
    requireValid(typeof value[key] === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value[key])
      && Number.isFinite(Date.parse(value[key])), `${key} must be a timezone-qualified ISO-8601 timestamp`);
  }
  requireValid(Date.parse(value.approvedAt as string) <= Date.parse(value.transitionExpiresAt as string), "approval must precede transition expiry");
  requireValid(now.getTime() <= Date.parse(value.transitionExpiresAt as string), "record expired after transitionExpiresAt");
  const measurement = value.measurement;
  requireValid(record(measurement) && measurement.command === REBASELINE_MEASUREMENT_COMMAND, "measurement must name the full RATCHET_ALL command");
  for (const key of ["baseLcovSha256", "candidateLcovSha256"] as const) {
    requireValid(typeof measurement[key] === "string" && /^[a-f0-9]{64}$/i.test(measurement[key]), `measurement.${key} must be a SHA-256 digest`);
  }
  requireValid(measurement.runUrl === null || (text(measurement.runUrl) && /^https?:\/\//.test(measurement.runUrl)), "measurement.runUrl must be an HTTP(S) URL or null");
  requireValid(Array.isArray(value.entries), "entries must be an array");
  const entries: unknown[] = value.entries;
  const seen = new Set<string>();
  for (const entry of entries) {
    requireValid(record(entry) && repoPath(entry.source), "every entry needs a repository-relative source");
    const source = entry.source;
    requireValid(!seen.has(source), `${source}: duplicate entry`);
    seen.add(source);
    for (const key of ["previousFloor", "measuredBefore", "measuredAfter", "newFloor", "configuredLineMinimum"] as const) {
      requireValid(percentage(entry[key]), `${source}: ${key} must be a finite percentage`);
    }
    requireValid(entry.previousFloor === previous[source], `${source}: previousFloor does not match the base baseline`);
    requireValid(entry.newFloor === candidate[source], `${source}: newFloor does not match the candidate baseline`);
    requireValid(entry.newFloor === entry.measuredAfter, `${source}: newFloor must equal measuredAfter`);
    requireValid(entry.configuredLineMinimum === lineMinimum(source), `${source}: configuredLineMinimum does not match the enforced minimum`);
    requireValid((entry.newFloor as number) >= lineMinimum(source), `${source}: newFloor is below the configured line minimum`);
    requireValid(entry.branchFloor === branchMinimum(source), `${source}: branchFloor must remain unchanged`);
    requireValid(text(entry.rationale) && entry.rationale.length <= 300, `${source}: rationale must contain 1–300 characters`);
    requireValid(typeof entry.protectedClass === "string"
      && ["R2", "published-number", "auth", "persistence", "provider-failure", "cron", "public-contract", "none"].includes(entry.protectedClass), `${source}: invalid protectedClass`);
    requireValid(Array.isArray(entry.removedTests) && entry.removedTests.length > 0, `${source}: removedTests must name the removed tests`);
    const removedTests: unknown[] = entry.removedTests;
    for (const removed of removedTests) {
      requireValid(record(removed) && repoPath(removed.path) && Array.isArray(removed.titles)
        && removed.titles.length > 0 && removed.titles.every((title: unknown) => text(title)), `${source}: removedTests needs paths and exact titles`);
    }
    requireValid(Array.isArray(entry.survivingOwners), `${source}: survivingOwners must be an array`);
    const owners: unknown[] = entry.survivingOwners;
    for (const owner of owners) {
      requireValid(record(owner) && repoPath(owner.path) && text(owner.title), `${source}: survivingOwners needs paths and exact titles`);
    }
    if (previous[source] - candidate[source] >= 1 || entry.protectedClass !== "none") {
      requireValid(owners.length > 0, `${source}: decrease of at least 1.0pt or protected class requires a surviving owner`);
    }
  }
  const decreased = decreasedCoverageSources(previous, candidate);
  requireValid(seen.size === decreased.length && decreased.every((source) => seen.has(source)), "entries must equal exactly the set of decreased sources (no extra or missing entries)");
  return value as unknown as CriticalCoverageRebaselineRecord;
}

export function requireCommittedCoverageRebaseline(
  compareRef: string,
  baselinePath: string,
  context: Omit<RebaselineContext, "previous">,
  execFile: BaseBlobExec,
): void {
  const git = (args: string[]) => execFile("git", args, { encoding: "utf8" }).toString();
  const previous = parseRebaselineBaseline(git(["show", `${compareRef}:${baselinePath}`]));
  if (decreasedCoverageSources(previous, context.candidate).length === 0) return;
  const baseSha = git(["rev-parse", `${compareRef}^{commit}`]).trim();
  const paths = git(["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", REBASELINE_DIRECTORY]).split("\0").filter((path) => path.endsWith(".json"));
  const failures: string[] = [];
  for (const path of paths) {
    try {
      const value: unknown = JSON.parse(git(["show", `HEAD:${path}`]));
      if (!record(value) || value.baseSha !== baseSha) continue;
      validateCriticalCoverageRebaseline(value, { ...context, previous });
      return;
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Baseline decrease requires a matching committed rebaseline record under ${REBASELINE_DIRECTORY}.${failures.length ? ` ${failures.join("; ")}` : ""}`);
}
