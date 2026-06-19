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
   * Unix seconds when this version became active, also used as the ordering key
   * for same-version/same-day entries (see sort in createMethodologyVersion).
   * Convention: when multiple entries share a calendar day, bump effectiveAt by
   * a synthetic 1-second offset (e.g. ...600, ...601, ...602) so earlier entries
   * get the lower value and resolve first.
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

function normalizeMethodologyVersionSegment(segment: string, width: number): number {
  const normalized = segment.padEnd(width, "0");
  const value = Number.parseInt(normalized, 10);
  return Number.isFinite(value) ? value : 0;
}

export function compareMethodologyVersions(a: string, b: string): number {
  const aParts = a.split(".");
  const bParts = b.split(".");
  const maxLength = Math.max(aParts.length, bParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const aPart = aParts[index] ?? "0";
    const bPart = bParts[index] ?? "0";
    const width = Math.max(aPart.length, bPart.length, 1);
    const diff =
      normalizeMethodologyVersionSegment(aPart, width) -
      normalizeMethodologyVersionSegment(bPart, width);
    if (diff !== 0) return diff;
  }

  return 0;
}

export function createMethodologyVersion(config: MethodologyVersionConfig): MethodologyVersion {
  const { currentVersion, changelogPath, changelog } = config;
  const versionLabel = toMethodologyVersionLabel(currentVersion);
  const sortedChangelog = [...changelog].sort((a, b) => {
    const versionDiff = compareMethodologyVersions(b.version, a.version);
    return versionDiff !== 0 ? versionDiff : b.effectiveAt - a.effectiveAt;
  });

  // Drift guard: the hand-maintained currentVersion must match the latest
  // changelog entry. Without this, adding a changelog entry but forgetting to
  // bump currentVersion silently mismatches the displayed label vs. what
  // getVersionAt() returns as latest. Dev/test only — never throws in prod.
  if (process.env.NODE_ENV !== "production") {
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
  return Number.isFinite(parsed.getTime())
    ? METHODOLOGY_DISPLAY_DATE_FORMATTER.format(parsed)
    : date;
}

export function methodologyChangelogEntryId(version: string): string {
  return `changelog-v-${slugifyId(version)}`;
}
