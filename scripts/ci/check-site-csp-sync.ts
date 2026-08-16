#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildStaticContentSecurityPolicy } from "@shared/lib/site-csp";

const HEADERS_PATH = resolve(process.cwd(), "public/_headers");
const CSP_HEADER_NAME = "Content-Security-Policy:";
const MANAGED_CSP_BY_SECTION = new Map([
  ["/*", buildStaticContentSecurityPolicy()],
  ["/pharoswatchbot/app", buildStaticContentSecurityPolicy({ telegramMiniApp: true })],
  ["/pharoswatchbot/app/*", buildStaticContentSecurityPolicy({ telegramMiniApp: true })],
]);

function parseArgs(argv: string[]): { write: boolean } {
  const allowed = new Set(["--write"]);
  for (const arg of argv) {
    if (!allowed.has(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { write: argv.includes("--write") };
}

function replaceManagedCspLines(contents: string): { next: string; errors: string[]; changed: boolean } {
  const lines = contents.split("\n");
  const errors: string[] = [];
  let currentSection: string | null = null;
  let changed = false;
  const seen = new Set<string>();

  const nextLines = lines.map((line) => {
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
      currentSection = line.trim();
      return line;
    }

    if (!currentSection || !MANAGED_CSP_BY_SECTION.has(currentSection)) {
      return line;
    }

    const trimmed = line.trimStart();
    if (!trimmed.startsWith(CSP_HEADER_NAME)) {
      return line;
    }

    seen.add(currentSection);
    const indent = line.slice(0, line.length - trimmed.length);
    const expected = `${indent}${CSP_HEADER_NAME} ${MANAGED_CSP_BY_SECTION.get(currentSection)}`;
    if (line !== expected) {
      errors.push(`${currentSection}: CSP does not match shared site-csp policy`);
      changed = true;
    }
    return expected;
  });

  for (const section of MANAGED_CSP_BY_SECTION.keys()) {
    if (!seen.has(section)) {
      errors.push(`${section}: missing managed Content-Security-Policy header`);
    }
  }

  return { next: nextLines.join("\n"), errors, changed };
}

export function runSiteCspSyncCheck(argv = process.argv.slice(2)): void {
  const { write } = parseArgs(argv);
  const contents = readFileSync(HEADERS_PATH, "utf8");
  const { next, errors, changed } = replaceManagedCspLines(contents);

  if (write && changed) {
    writeFileSync(HEADERS_PATH, next);
    console.log("Updated public/_headers CSP lines from shared site-csp policy.");
    return;
  }

  if (errors.length > 0) {
    console.error("Site CSP/static header drift detected:");
    for (const error of errors) {
      console.error(`  ${error}`);
    }
    console.error("");
    console.error("Regenerate the managed CSP lines with:");
    console.error("  npx --no-install tsx scripts/ci/check-site-csp-sync.ts --write");
    process.exit(1);
  }

  console.log("Site CSP/static header sync check passed.");
}

runSiteCspSyncCheck();
