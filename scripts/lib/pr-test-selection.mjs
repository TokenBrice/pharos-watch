import { matchesGlob } from "node:path";
import { CRITICAL_CONTRACT_TEST_FILES } from "./critical-test-files.mjs";

export function parseVitestFileList(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\[[^\]]+\]\s+/, "").replaceAll("\\", "/"))
    .filter((line) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(line));
}

export function selectPrTestFiles(changedTestFiles, criticalFiles = CRITICAL_CONTRACT_TEST_FILES) {
  return [...new Set([...criticalFiles, ...changedTestFiles])].sort();
}

export function isTestFile(path) {
  return matchesGlob(path, "**/*.{test,spec}.{js,jsx,ts,tsx,mjs,mts,cjs,cts}");
}
