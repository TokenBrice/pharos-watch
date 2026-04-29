#!/usr/bin/env node
/**
 * Lightweight color guard for the PharosVille route.
 *
 * The old harbor scene enforced a single TypeScript palette module. PharosVille
 * now keeps route-local CSS and canvas placeholder colors, so this check only
 * blocks unsafe placeholder/debug colors and one-off purple/orb-style drift.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";

const trackedFiles = execFileSync("git", ["ls-files", "src/app/pharosville"], { encoding: "utf8" }).split("\n");
const sourceExtensionPattern = /\.(?:css|ts|tsx)$/;
const testFilePattern = /(?:^|\/)(?:__tests__|tests?)\/|\.test\.(?:ts|tsx)$/;
const waiverPattern = /pharosville-color-guard:\s*allow/i;
const files = trackedFiles
  .filter((file) => existsSync(file) && sourceExtensionPattern.test(file) && !testFilePattern.test(file))
  .sort();

const bannedPatterns = [
  { pattern: /checkerboard/i, message: "checkerboard placeholder text is not allowed in production route files" },
  { pattern: /#(?:a855f7|9333ea|7c3aed|8b5cf6)/i, message: "avoid default purple accent drift in PharosVille" },
  { pattern: /\b(?:orb|orbs|bokeh)\b/i, message: "decorative orb/bokeh language is not part of the PharosVille visual system" },
];

const failures = [];

for (const file of files) {
  const source = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !waiverPattern.test(line))
    .join("\n");
  for (const { pattern, message } of bannedPatterns) {
    if (pattern.test(source)) failures.push(`${file}: ${message}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`PharosVille color check passed for ${files.length} non-test source files.`);
