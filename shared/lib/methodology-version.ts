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

export function createMethodologyVersion(config: MethodologyVersionConfig): MethodologyVersion {
  const { currentVersion, changelogPath, changelog } = config;
  const versionLabel = `v${currentVersion}`;

  const windows: VersionWindow[] = changelog
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

  return { currentVersion, versionLabel, changelogPath, changelog, getVersionAt };
}

export function toMethodologyVersionLabel(version: string): string {
  return `v${version}`;
}
