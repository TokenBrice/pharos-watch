/**
 * Generic methodology version infrastructure.
 *
 * Each methodology defines its changelog data and passes it to
 * createMethodologyVersion() to get version resolution, labels,
 * and sorted windows — eliminating boilerplate duplication across
 * the 6 methodology version files.
 */

export interface MethodologyChangelogEntry {
  version: string;
  title: string;
  date: string;
  effectiveAt: number;
  summary: string;
  impact: readonly string[];
  commits: readonly string[];
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
  changelogPath: string;
  changelog: readonly MethodologyChangelogEntry[];
  getVersionAt: (unixSeconds: number) => string;
}

function parseMethodologyVersion(version: string): number[] {
  return version.split(".").map((segment) => {
    const value = Number.parseInt(segment, 10);
    return Number.isFinite(value) ? value : 0;
  });
}

export function compareMethodologyVersions(a: string, b: string): number {
  const aParts = parseMethodologyVersion(a);
  const bParts = parseMethodologyVersion(b);
  const maxLength = Math.max(aParts.length, bParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const diff = (aParts[index] ?? 0) - (bParts[index] ?? 0);
    if (diff !== 0) return diff;
  }

  return 0;
}

export function createMethodologyVersion(config: MethodologyVersionConfig): MethodologyVersion {
  const { currentVersion, changelogPath, changelog } = config;
  const versionLabel = `v${currentVersion}`;
  const sortedChangelog = [...changelog].sort((a, b) => {
    const versionDiff = compareMethodologyVersions(b.version, a.version);
    return versionDiff !== 0 ? versionDiff : b.effectiveAt - a.effectiveAt;
  });

  const windows: VersionWindow[] = sortedChangelog
    .map((entry) => ({ version: entry.version, effectiveAt: entry.effectiveAt }))
    .sort((a, b) => a.effectiveAt - b.effectiveAt);

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

  return { currentVersion, versionLabel, changelogPath, changelog: sortedChangelog, getVersionAt };
}

export function toMethodologyVersionLabel(version: string): string {
  return `v${version}`;
}
