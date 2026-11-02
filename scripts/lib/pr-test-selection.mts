import { existsSync } from "node:fs";
import { CRITICAL_OWNERSHIP } from "./critical-coverage.mjs";
import { assertExecutableTestFiles, collectOwningTests, normalizeOwnershipPath, type CriticalOwnership } from "./critical-ownership.mts";
import { ALWAYS_RUN_TEST_FILES } from "./critical-test-files.mts";
import { hasOnlyInternalDocsImpact } from "./deploy-impact.mts";
import { DECLARED_TEST_OWNERSHIP, matchesOwnershipGlob } from "./doc-ownership-registry.mts";
import { isNightlyTestFile } from "./nightly-test-tier.mts";
import { PR_DOC_COMMANDS } from "./pr-lanes.mts";
export { ALWAYS_RUN_TEST_FILES };

/**
 * Test files the docs owner already reruns through `PR_DOC_COMMANDS`. A
 * doc-only declaration is skipped only when every one of its tests is here;
 * any other doc-owned test keeps its place in the plan.
 */
export const PR_DOC_OWNER_TEST_FILES: ReadonlySet<string> = new Set(
  PR_DOC_COMMANDS.flatMap((command) =>
    command.args.filter((arg) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(arg)).map(normalizeOwnershipPath)),
);


export function parseVitestFileList(output: unknown): string[] {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\[[^\]]+\]\s+/, "").replaceAll("\\", "/"))
    .filter((line) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(line));
}

export interface SelectPrTestFilesOptions {
  /**
   * The change set includes internal docs, whose owner (static guards, or the
   * docs-only inline path) already runs the doc-ownership and router invariant
   * suites. A declaration is skipped only when every changed source it matches
   * is documentation and every one of its tests is in `PR_DOC_COMMANDS`; any
   * other doc-owned test keeps its place in the plan.
   */
  docsChanged?: boolean;
}

export function selectPrTestFiles(
  changedTestFiles: readonly string[],
  criticalFiles: readonly string[] = ALWAYS_RUN_TEST_FILES,
  changedSourceFiles: readonly string[] = [],
  ownership: CriticalOwnership = CRITICAL_OWNERSHIP,
  exists: (path: string) => boolean = existsSync,
  { docsChanged = false }: SelectPrTestFilesOptions = {},
): string[] {
  if (criticalFiles.length > 0) assertExecutableTestFiles(criticalFiles, { exists });
  const nightlyCritical = criticalFiles.filter(isNightlyTestFile);
  if (nightlyCritical.length > 0) {
    throw new Error(`Nightly-tier test cannot be an always-run PR contract: ${nightlyCritical.join(", ")}`);
  }
  const selected = new Set([...criticalFiles, ...changedTestFiles.filter((file) => exists(file))]);
  for (const test of collectOwningTests(changedSourceFiles, ownership)) {
    if (exists(test)) selected.add(test);
  }
  for (const declaration of DECLARED_TEST_OWNERSHIP) {
    const matchingSources = changedSourceFiles.filter((file) =>
      declaration.sources.some((glob) => matchesOwnershipGlob(normalizeOwnershipPath(file), glob)));
    if (matchingSources.length === 0) continue;
    // The docs owner already runs the doc-ownership/router invariants; skip a
    // declaration only when it has nothing else to run and every changed source
    // is documentation. Other doc-owned suites (e.g. a runbook validator) stay.
    if (docsChanged
      && matchingSources.every((file) => hasOnlyInternalDocsImpact([normalizeOwnershipPath(file)]))
      && declaration.tests.every((test) => PR_DOC_OWNER_TEST_FILES.has(normalizeOwnershipPath(test)))) {
      continue;
    }
    assertExecutableTestFiles(declaration.tests, { exists });
    for (const test of declaration.tests) selected.add(test);
  }
  // The nightly tier runs in `npm test` and the nightly shards only
  // (`scripts/lib/nightly-test-tier.mts`); a changed nightly file, a declared
  // owner or an `vitest list --changed` entry never re-enters the PR tier.
  const files = [...selected]
    .map(normalizeOwnershipPath)
    .filter((file) => !isNightlyTestFile(file))
    .sort();
  assertExecutableTestFiles(files, { exists });
  return files;
}
