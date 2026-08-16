import { matchesGlob } from "node:path";
import { CRITICAL_CONTRACT_TEST_FILES, GLOBAL_INVARIANT_TEST_FILES } from "./critical-test-files.mts";

const ALWAYS_RUN_TEST_FILES: string[] = [...new Set([...GLOBAL_INVARIANT_TEST_FILES, ...CRITICAL_CONTRACT_TEST_FILES])];

export function parseVitestFileList(output: unknown): string[] {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\[[^\]]+\]\s+/, "").replaceAll("\\", "/"))
    .filter((line) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(line));
}

export function selectPrTestFiles(
  changedTestFiles: readonly string[],
  criticalFiles: readonly string[] = ALWAYS_RUN_TEST_FILES,
): string[] {
  return [...new Set([...criticalFiles, ...changedTestFiles])].sort();
}

export function isTestFile(path: string): boolean {
  return matchesGlob(path, "**/*.{test,spec}.{js,jsx,ts,tsx,mjs,mts,cjs,cts}");
}
