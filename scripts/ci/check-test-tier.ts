#!/usr/bin/env node
/**
 * Structural guard for the nightly test tier
 * (`scripts/lib/nightly-test-tier.mts`).
 *
 * A tier move removes PR signal, so two claims must hold:
 *
 * 1. Every `*.nightly.test.ts(x)` file names the PR-tier test or guard that
 *    keeps its behavior visible before merge:
 *    `// Nightly tier: PR coverage retained by <repo-relative path>`.
 *    A missing, unreadable or self-referential pointer fails.
 * 2. No PR-tier safety net carries the tier. The always-run/critical test
 *    lists, the provider-resilience registry's per-surface tests, the declared
 *    test ownership in `docs/doc-ownership.json` and the docs-owner commands
 *    may name neither a nightly file nor a `nightly`-tagged case.
 *
 * `check-critical-coverage.ts` runs `collectTestTierViolations` inside its
 * every-PR completeness gate, because that leaf already derives the critical
 * ownership these lists come from; the CLI here
 * (`npm run check:test-tier`) is the focused authoring run and the suite's
 * entrypoint. Either path fails in the PR that makes an unguarded move.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runDirectCli } from "../lib/cli-args.mjs";
import { ALWAYS_RUN_TEST_FILES, CRITICAL_TEST_FILES } from "../lib/critical-test-files.mts";
import { DECLARED_TEST_OWNERSHIP } from "../lib/doc-ownership-registry.mts";
import {
  collectNightlyTestFiles,
  declaresNightlyTag,
  isNightlyTestFile,
  readNightlyTierPointer,
} from "../lib/nightly-test-tier.mts";
import { PR_DOC_COMMANDS } from "../lib/pr-lanes.mts";
import { TEST_FILE_PATTERN } from "../lib/pr-import-graph.mts";
import { PROVIDER_RESILIENCE_REGISTRY } from "../lib/provider-resilience-registry.mjs";
import { reportViolations } from "../lib/report-violations.mts";

export interface TestTierViolation {
  kind: string;
  message: string;
}

export interface TestTierList {
  name: string;
  tests: readonly string[];
}

/**
 * The lists that must stay in the PR tier: the always-run/critical contracts,
 * the provider-resilience registry's per-surface regression tests, the declared
 * source-inspecting owners, and the suites the docs owner already runs.
 */
export const PR_TIER_SAFETY_NET: readonly TestTierList[] = [
  { name: "ALWAYS_RUN_TEST_FILES", tests: ALWAYS_RUN_TEST_FILES },
  { name: "CRITICAL_TEST_FILES", tests: CRITICAL_TEST_FILES },
  {
    name: "PROVIDER_RESILIENCE_REGISTRY.tests",
    tests: PROVIDER_RESILIENCE_REGISTRY.flatMap((entry) => entry.tests ?? []),
  },
  {
    name: "DECLARED_TEST_OWNERSHIP",
    tests: DECLARED_TEST_OWNERSHIP.flatMap((declaration) => declaration.tests),
  },
  {
    name: "PR_DOC_COMMANDS",
    tests: PR_DOC_COMMANDS.flatMap((command) => command.args).filter((arg) => TEST_FILE_PATTERN.test(arg)),
  },
];

export interface TestTierScanOptions {
  cwd?: string;
  /** Defaults to the checkout scan; tests supply a fixture list. */
  nightlyFiles?: readonly string[];
  safetyNet?: readonly TestTierList[];
  readSource?: (path: string) => string;
}

export function collectTestTierViolations({
  cwd = process.cwd(),
  nightlyFiles = collectNightlyTestFiles(cwd),
  safetyNet = PR_TIER_SAFETY_NET,
  readSource = (path: string) => readFileSync(resolve(cwd, path), "utf8"),
}: TestTierScanOptions = {}): TestTierViolation[] {
  const violations: TestTierViolation[] = [];
  const read = (file: string): string | null => {
    try {
      return readSource(file);
    } catch {
      return null;
    }
  };
  const seen = new Set<string>();
  for (const file of nightlyFiles) {
    const nightly = isNightlyTestFile(file);
    if (seen.has(file)) continue;
    seen.add(file);
    if (!nightly) {
      violations.push({ kind: "invalid-nightly-file", message: `${file} is not named *.nightly.test.ts(x)` });
      continue;
    }
    // The pointer keeps the tier honest: a header line names the PR-tier test
    // or guard that still fails before merge when this behavior regresses.
    const source = read(file);
    if (source === null) {
      violations.push({ kind: "unreadable-nightly-file", message: `${file} could not be read` });
      continue;
    }
    const pointer = readNightlyTierPointer(source);
    if (pointer === null) {
      violations.push({
        kind: "missing-pr-pointer",
        message: `${file} must start with "// Nightly tier: PR coverage retained by <path>"`,
      });
      continue;
    }
    if (isNightlyTestFile(pointer)) {
      violations.push({ kind: "nightly-pr-pointer", message: `${file} names nightly-tier ${pointer} as its PR coverage` });
      continue;
    }
    if (!existsSync(resolve(cwd, pointer))) {
      violations.push({ kind: "missing-pr-pointer-target", message: `${file} names missing PR-tier owner ${pointer}` });
    }
  }

  for (const list of safetyNet) {
    for (const test of [...new Set(list.tests)]) {
      if (isNightlyTestFile(test)) {
        violations.push({ kind: "nightly-file-in-pr-tier", message: `${list.name} lists nightly-tier file ${test}` });
        continue;
      }
      const source = read(test);
      if (source === null) {
        violations.push({ kind: "missing-pr-tier-test", message: `${list.name} references missing test file ${test}` });
        continue;
      }
      if (declaresNightlyTag(source)) {
        violations.push({ kind: "nightly-case-in-pr-tier", message: `${list.name} lists a nightly-tagged case in ${test}` });
      }
    }
  }

  // One line per distinct defect: the same file can be listed by several
  // safety-net lists (always-run is a subset of the critical owners).
  return [...new Map(violations.map((violation) => [`${violation.kind}\u0000${violation.message}`, violation])).values()];
}

export function checkTestTier({
  cwd = process.cwd(),
  nightlyFiles = collectNightlyTestFiles(cwd),
  stdout = process.stdout,
  stderr = process.stderr,
}: {
  cwd?: string;
  nightlyFiles?: readonly string[];
  stdout?: { write: (chunk: string) => unknown };
  stderr?: { write: (chunk: string) => unknown };
} = {}): number {
  const violations = collectTestTierViolations({ cwd, nightlyFiles });
  const status = reportViolations({
    label: "[test-tier]",
    violations: violations.map((violation) => `${violation.kind}: ${violation.message}`),
    heading: "Nightly test tier violations",
    hint: "Name the PR-tier test or guard in the nightly file header; move the case back to the PR tier instead of relaxing a safety net.",
    stderr,
  });
  if (status === 0) {
    stdout.write(
      `[test-tier] OK: ${nightlyFiles.length} nightly-tier file(s), ${PR_TIER_SAFETY_NET.length} PR-tier safety-net list(s); `
      + "no nightly file or case outside the tier\n",
    );
  }
  return status;
}

runDirectCli(import.meta.url, () => {
  process.exitCode = checkTestTier();
});
