import { existsSync } from "node:fs";
import { matchesGlob } from "node:path";
import { CRITICAL_OWNERSHIP } from "./critical-coverage.mjs";
import { assertExecutableTestFiles, collectOwningTests, normalizeOwnershipPath, type CriticalOwnership } from "./critical-ownership.mts";
import { ALWAYS_RUN_TEST_FILES } from "./critical-test-files.mts";
import { DECLARED_TEST_OWNERSHIP, matchesOwnershipGlob } from "./doc-ownership-registry.mts";
export { ALWAYS_RUN_TEST_FILES };


export function parseVitestFileList(output: unknown): string[] {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\[[^\]]+\]\s+/, "").replaceAll("\\", "/"))
    .filter((line) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(line));
}

export function selectPrTestFiles(
  changedTestFiles: readonly string[],
  criticalFiles: readonly string[] = ALWAYS_RUN_TEST_FILES,
  changedSourceFiles: readonly string[] = [],
  ownership: CriticalOwnership = CRITICAL_OWNERSHIP,
  exists: (path: string) => boolean = existsSync,
): string[] {
  if (criticalFiles.length > 0) assertExecutableTestFiles(criticalFiles, { exists });
  const selected = new Set([...criticalFiles, ...changedTestFiles.filter((file) => exists(file))]);
  for (const test of collectOwningTests(changedSourceFiles, ownership)) {
    if (exists(test)) selected.add(test);
  }
  for (const declaration of DECLARED_TEST_OWNERSHIP) {
    if (!changedSourceFiles.some((file) => declaration.sources.some((glob) => matchesOwnershipGlob(normalizeOwnershipPath(file), glob)))) continue;
    assertExecutableTestFiles(declaration.tests, { exists });
    for (const test of declaration.tests) selected.add(test);
  }
  const files = [...selected].map(normalizeOwnershipPath).sort();
  assertExecutableTestFiles(files, { exists });
  return files;
}

export function isTestFile(path: string): boolean {
  return matchesGlob(path, "**/*.{test,spec}.{js,jsx,ts,tsx,mjs,mts,cjs,cts}");
}
