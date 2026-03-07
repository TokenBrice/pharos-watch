---
title: "Create shared/lib/methodology-version.ts generic factory with tests"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Create a generic `createMethodologyVersion()` factory that encapsulates the boilerplate shared by all 6 methodology version files: the version window sorting, the `getVersionAt()` timestamp resolver, and the `toVersionLabel()` formatter.

## Context

The codebase has 6 methodology version files in `shared/lib/` that each follow an identical pattern:

1. `VERSION` constant
2. `VERSION_LABEL` = `` `v${VERSION}` ``
3. `CHANGELOG_PATH` constant
4. A changelog entry interface (identical fields except one: `methodologyImpact` / `scoreImpact` / `trackingImpact`)
5. A `CHANGELOG` array (the actual data — unique per file)
6. `VERSION_WINDOWS_ASC` — sorted copy of changelog (identical logic)
7. `getXMethodologyVersionAt(unixSeconds)` — identical algorithm in all 6 files
8. `toXMethodologyVersionLabel(version)` — identical `return \`v${version}\`` in all 6 files

This ticket creates the generic factory. TICKET-002 migrates the 6 files to use it.

## Task

### Step 1: Create the factory module

Create **`shared/lib/methodology-version.ts`** with this exact content:

```typescript
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
```

### Step 2: Create tests for the factory

Create **`src/lib/__tests__/methodology-version.test.ts`** with this content:

```typescript
import { describe, it, expect } from "vitest";
import {
  createMethodologyVersion,
  toMethodologyVersionLabel,
  type MethodologyChangelogEntry,
} from "@shared/lib/methodology-version";

const TEST_CHANGELOG: MethodologyChangelogEntry[] = [
  {
    version: "2.0",
    title: "Second release",
    date: "2026-02-01",
    effectiveAt: 1000,
    summary: "Second version",
    impact: ["Change A"],
    commits: ["abc123"],
    reconstructed: false,
  },
  {
    version: "1.0",
    title: "Initial release",
    date: "2026-01-01",
    effectiveAt: 500,
    summary: "First version",
    impact: ["Launch"],
    commits: ["def456"],
    reconstructed: true,
  },
];

describe("createMethodologyVersion", () => {
  const mv = createMethodologyVersion({
    currentVersion: "2.0",
    changelogPath: "/methodology/test-changelog/",
    changelog: TEST_CHANGELOG,
  });

  it("exposes currentVersion and versionLabel", () => {
    expect(mv.currentVersion).toBe("2.0");
    expect(mv.versionLabel).toBe("v2.0");
  });

  it("exposes changelogPath", () => {
    expect(mv.changelogPath).toBe("/methodology/test-changelog/");
  });

  it("resolves version at timestamp", () => {
    expect(mv.getVersionAt(499)).toBe("1.0");
    expect(mv.getVersionAt(500)).toBe("1.0");
    expect(mv.getVersionAt(999)).toBe("1.0");
    expect(mv.getVersionAt(1000)).toBe("2.0");
    expect(mv.getVersionAt(9999)).toBe("2.0");
  });

  it("returns currentVersion for non-finite timestamps", () => {
    expect(mv.getVersionAt(Number.NaN)).toBe("2.0");
    expect(mv.getVersionAt(Number.POSITIVE_INFINITY)).toBe("2.0");
    expect(mv.getVersionAt(Number.NEGATIVE_INFINITY)).toBe("2.0");
  });

  it("handles empty changelog", () => {
    const empty = createMethodologyVersion({
      currentVersion: "1.0",
      changelogPath: "/test/",
      changelog: [],
    });
    expect(empty.getVersionAt(999)).toBe("1.0");
  });
});

describe("toMethodologyVersionLabel", () => {
  it("prefixes version with v", () => {
    expect(toMethodologyVersionLabel("3.1")).toBe("v3.1");
  });
});
```

### Step 3: Verify

Run: `npx vitest run src/lib/__tests__/methodology-version.test.ts`

Expected: All tests pass.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `test -f shared/lib/methodology-version.ts` exits 0
- `test -f src/lib/__tests__/methodology-version.test.ts` exits 0
- `npx vitest run src/lib/__tests__/methodology-version.test.ts` passes all tests
- `grep -c "createMethodologyVersion" shared/lib/methodology-version.ts` returns at least 2 (export + function)
