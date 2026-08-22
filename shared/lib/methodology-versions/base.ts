/**
 * Generic methodology version infrastructure.
 *
 * Each methodology defines its changelog data and passes it to
 * createMethodologyVersion() to get version resolution, labels,
 * and sorted windows — eliminating boilerplate duplication across
 * methodology version files.
 */

import { slugifyId } from "../format";

export interface MethodologyChangelogEntry {
  version: string;
  title: string;
  date: string;
  /**
   * Unix seconds when this version became active. Entries may share an activation
   * timestamp when they were released as one batch; getVersionAt() resolves such
   * ties to the highest numeric version. Use synthetic one-second offsets only
   * when the activation order within a batch is itself meaningful.
   */
  effectiveAt: number;
  summary: string;
  impact: readonly string[];
  /**
   * Real commit hashes only; best-effort and independent of `reconstructed`.
   * Empty means commit provenance was not recorded — this is expected for many
   * contemporaneous (`reconstructed: false`) entries too, not just reconstructed
   * ones, so an empty `commits` array does not contradict `reconstructed: false`.
   */
  commits: readonly string[];
  /**
   * Origin of the entry, not a statement about commit evidence:
   * `false` = written contemporaneously with the methodology change;
   * `true` = reconstructed after the fact from git history.
   * The `commits` field is best-effort in both cases (it may be empty either way).
   */
  reconstructed: boolean;
}

interface VersionWindow {
  version: string;
  effectiveAt: number;
}

function shouldRunDevelopmentAssertions(): boolean {
  const runtimeProcess = typeof process !== "undefined" ? process : undefined;
  return runtimeProcess != null && runtimeProcess.env?.NODE_ENV !== "production";
}

export interface MethodologyVersionConfig {
  currentVersion: string;
  changelogPath: string;
  changelog: readonly MethodologyChangelogEntry[];
}

export interface MethodologyVersion {
  currentVersion: string;
  versionLabel: string;
  /** All changelog versions as display labels (e.g. ["v8.0", "v7.9", …]), newest first. */
  versionLabels: string[];
  changelogPath: string;
  changelog: readonly MethodologyChangelogEntry[];
  getVersionAt: (unixSeconds: number) => string;
}

function parseMethodologyVersionSegment(segment: string): number {
  const value = Number.parseInt(segment, 10);
  return Number.isFinite(value) ? value : 0;
}

function normalizeMethodologyMinorVersionSegment(segment: string, width: number): number {
  return parseMethodologyVersionSegment(segment.padEnd(width, "0"));
}

function parseMethodologyVersion(version: string): { major: number; minor: string } {
  const match = version.match(/^(\d+)\.(\d+)$/u);
  if (!match) {
    throw new Error(`Invalid methodology version "${version}". Expected numeric two-segment form like "5.91".`);
  }
  return {
    major: parseMethodologyVersionSegment(match[1] ?? "0"),
    minor: match[2] ?? "0",
  };
}

export function compareMethodologyVersions(a: string, b: string): number {
  const aVersion = parseMethodologyVersion(a);
  const bVersion = parseMethodologyVersion(b);
  const majorDiff = aVersion.major - bVersion.major;
  if (majorDiff !== 0) return majorDiff;

  const width = Math.max(aVersion.minor.length, bVersion.minor.length, 1);
  return (
    normalizeMethodologyMinorVersionSegment(aVersion.minor, width) -
    normalizeMethodologyMinorVersionSegment(bVersion.minor, width)
  );
}

export function createMethodologyVersion(config: MethodologyVersionConfig): MethodologyVersion {
  const { currentVersion, changelogPath, changelog } = config;
  parseMethodologyVersion(currentVersion);
  for (const entry of changelog) {
    parseMethodologyVersion(entry.version);
  }
  const versionLabel = toMethodologyVersionLabel(currentVersion);
  const sortedChangelog = [...changelog].sort((a, b) => {
    const versionDiff = compareMethodologyVersions(b.version, a.version);
    return versionDiff !== 0 ? versionDiff : b.effectiveAt - a.effectiveAt;
  });

  // Drift guard: the hand-maintained currentVersion must match the latest
  // changelog entry. Without this, adding a changelog entry but forgetting to
  // bump currentVersion silently mismatches the displayed label vs. what
  // getVersionAt() returns as latest. Dev/test only — never throws in prod.
  if (shouldRunDevelopmentAssertions()) {
    const latest = sortedChangelog[0]?.version;
    if (latest && latest !== currentVersion) {
      throw new Error(
        `Methodology version drift for ${changelogPath}: currentVersion="${currentVersion}" ` +
          `but latest changelog entry is "${latest}". Update currentVersion to match.`,
      );
    }
  }

  const windows: VersionWindow[] = sortedChangelog
    .map((entry) => ({ version: entry.version, effectiveAt: entry.effectiveAt }))
    .sort((a, b) => {
      const timeDiff = a.effectiveAt - b.effectiveAt;
      if (timeDiff !== 0) return timeDiff;
      return compareMethodologyVersions(a.version, b.version);
    });

  // A later activation may keep the same version (multiple editorial entries),
  // but it must never resolve to an older version. Without this invariant,
  // future-dated or misordered entries can silently roll runtime consumers back.
  if (shouldRunDevelopmentAssertions()) {
    let highestActivatedVersion = windows[0]?.version;
    for (const window of windows.slice(1)) {
      if (
        highestActivatedVersion &&
        compareMethodologyVersions(window.version, highestActivatedVersion) < 0
      ) {
        throw new Error(
          `Methodology activation chronology drift for ${changelogPath}: ` +
            `v${window.version} at ${window.effectiveAt} follows newer v${highestActivatedVersion}. ` +
            "Fix effectiveAt so activated versions never regress.",
        );
      }
      if (
        !highestActivatedVersion ||
        compareMethodologyVersions(window.version, highestActivatedVersion) > 0
      ) {
        highestActivatedVersion = window.version;
      }
    }
  }

  function getVersionAt(unixSeconds: number): string {
    if (!Number.isFinite(unixSeconds)) return currentVersion;

    let resolved = windows[0]?.version ?? currentVersion;
    for (const window of windows) {
      if (unixSeconds >= window.effectiveAt) {
        resolved = window.version;
      } else {
        break;
      }
    }
    return resolved;
  }

  const versionLabels = sortedChangelog.map((entry) => toMethodologyVersionLabel(entry.version));
  return { currentVersion, versionLabel, versionLabels, changelogPath, changelog: sortedChangelog, getVersionAt };
}

export function toMethodologyVersionLabel(version: string): string {
  return `v${version}`;
}

const METHODOLOGY_DISPLAY_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function formatMethodologyDisplayDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) ? METHODOLOGY_DISPLAY_DATE_FORMATTER.format(parsed) : date;
}

export function methodologyChangelogEntryId(version: string): string {
  return `changelog-v-${slugifyId(version)}`;
}
