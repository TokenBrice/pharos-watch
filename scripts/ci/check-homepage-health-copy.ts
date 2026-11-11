#!/usr/bin/env node
/**
 * Keeps data-health warning copy off the homepage source
 * (`docs/homepage.md#data-health`): data renders as-is, no data is a neutral
 * placeholder, and ops state lives in admin/alerts. The rendered matrix in
 * `src/components/__tests__/homepage-no-health-warnings.test.tsx` proves the
 * mounted behaviour; this reads the authored source, including the mini-cards
 * and `home-*` wrappers the matrix does not mount directly.
 */

import { globSync, readFileSync, statSync } from "node:fs";
import { basename, matchesGlob, relative, resolve } from "node:path";
import { formatScannedOk } from "../lib/source-files.mts";
import { runDirectCli } from "../lib/cli-args.mjs";
import { HOMEPAGE_COPY_GLOBS, HOMEPAGE_COPY_IGNORES } from "../lib/homepage-copy-policy.mjs";

// This wrapper supplies the neutral fallback and may use the shared error boundary.
const EXCLUDED_COMPONENTS = new Set(["home-section-error-boundary.tsx"]);

/** Literal warning copy, plus the shared error boundary that renders a notice. */
const BANNED_PHRASES =
  /Data quality warning|Refresh failed|Freshness unavailable|temporarily unavailable|Retained (snapshot|observation)|>\s*Retry\s*<|<SectionErrorBoundary\b/;
/** JSX text only: state words in rendered copy, not identifiers like `isStale`. */
const BANNED_STATE_TEXT = />[^<>{}]*\b(stale|retained|degraded)\b[^<>{}]*</i;

interface HomepageCopyFinding {
  file: string;
  match: string;
}

interface HomepageCopyOptions {
  cwd?: string;
  stdout?: { write(data: string): unknown };
  stderr?: { write(data: string): unknown };
}

/** The authored homepage surfaces the guard reads; used for PR selection too. */
export function isHomepageCopyPath(file: string): boolean {
  if (file === "scripts/ci/check-homepage-health-copy.ts" || file === "scripts/lib/homepage-copy-policy.mjs") return true;
  return HOMEPAGE_COPY_GLOBS.some((glob) => matchesGlob(file, glob))
    && !HOMEPAGE_COPY_IGNORES.some((glob) => matchesGlob(file, glob))
    && !EXCLUDED_COMPONENTS.has(basename(file));
}

export function collectHomepageCopyFiles(cwd = process.cwd()): string[] {
  if (!statSync(resolve(cwd, "src/components/homepage")).isDirectory()) {
    throw new Error("Required homepage component directory is missing");
  }
  return [...new Set(["src/app/page.tsx", ...globSync(HOMEPAGE_COPY_GLOBS, { cwd })])]
    .filter(isHomepageCopyPath).sort();
}

export function findHomepageHealthCopy(
  files: readonly string[],
  cwd = process.cwd(),
): HomepageCopyFinding[] {
  const findings: HomepageCopyFinding[] = [];
  for (const file of files) {
    const source = readFileSync(resolve(cwd, file), "utf8");
    for (const pattern of [BANNED_PHRASES, BANNED_STATE_TEXT]) {
      const match = source.match(pattern);
      if (match) findings.push({ file: relative(cwd, resolve(cwd, file)).replaceAll("\\", "/"), match: match[0] });
    }
  }
  return findings;
}

export function checkHomepageHealthCopy({
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
}: HomepageCopyOptions = {}): number {
  const files = collectHomepageCopyFiles(cwd);
  const findings = findHomepageHealthCopy(files, cwd);
  if (findings.length === 0) {
    stdout.write(formatScannedOk("[homepage-health-copy] The homepage avoids data-health warning copy", files.length));
    return 0;
  }

  stderr.write("\n[homepage-health-copy] Data-health warning copy on the homepage source:\n\n");
  for (const finding of findings) {
    stderr.write(`  ${finding.file}: ${JSON.stringify(finding.match)}\n`);
  }
  stderr.write("\nRender data as-is: no data is a neutral placeholder. See docs/homepage.md#data-health.\n");
  return 1;
}

runDirectCli(import.meta.url, () => {
  process.exitCode = checkHomepageHealthCopy();
});
