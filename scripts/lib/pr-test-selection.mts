import { matchesGlob } from "node:path";
import { CRITICAL_FILES } from "./critical-coverage.mjs";
import { collectOwningTests, deriveCriticalOwnership, normalizeOwnershipPath, type CriticalOwnership } from "./critical-ownership.mts";
import { ALWAYS_RUN_TEST_FILES } from "./critical-test-files.mts";
export { ALWAYS_RUN_TEST_FILES };
const CRITICAL_OWNERSHIP: CriticalOwnership = deriveCriticalOwnership({ sourceFiles: CRITICAL_FILES });


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
): string[] {
  const selected = new Set([...criticalFiles, ...changedTestFiles]);
  for (const test of collectOwningTests(changedSourceFiles, ownership)) selected.add(test);
  return [...selected].map(normalizeOwnershipPath).sort();
}

export function isTestFile(path: string): boolean {
  return matchesGlob(path, "**/*.{test,spec}.{js,jsx,ts,tsx,mjs,mts,cjs,cts}");
}
