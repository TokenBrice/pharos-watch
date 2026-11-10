#!/usr/bin/env node
/**
 * Keeps data-health warning copy off the homepage source
 * (`docs/homepage.md#data-health`): data renders as-is, no data is a neutral
 * placeholder, and ops state lives in admin/alerts. The rendered matrix in
 * `src/components/__tests__/homepage-no-health-warnings.test.tsx` proves the
 * mounted behaviour; this reads the authored source, including the mini-cards
 * and `home-*` wrappers the matrix does not mount directly.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { formatScannedOk } from "../lib/source-files.mts";
import { runDirectCli } from "../lib/cli-args.mjs";

const PAGE = "src/app/page.tsx";
const COMPONENTS = "src/components";
const MINI_CARDS = "src/components/home-alt-mini-cards";
const EXCLUDED_COMPONENTS = new Set(["home-section-error-boundary.tsx"]);
const HOME_COMPONENT = /^home(page)?-.*\.tsx$/;

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
  if (file === PAGE || file === "scripts/ci/check-homepage-health-copy.ts") return true;
  if (file.startsWith(`${MINI_CARDS}/`)) return file.endsWith(".tsx");
  const name = file.slice(COMPONENTS.length + 1);
  return file.startsWith(`${COMPONENTS}/`) && !file.slice(COMPONENTS.length + 1).includes("/")
    && HOME_COMPONENT.test(name) && !EXCLUDED_COMPONENTS.has(name);
}

export function collectHomepageCopyFiles(cwd = process.cwd()): string[] {
  const files = [PAGE];
  for (const name of readdirSync(resolve(cwd, COMPONENTS))) {
    if (HOME_COMPONENT.test(name) && !EXCLUDED_COMPONENTS.has(name)) {
      files.push(join(COMPONENTS, name));
    }
  }
  const miniCards = resolve(cwd, MINI_CARDS);
  if (existsSync(miniCards)) {
    for (const name of readdirSync(miniCards)) {
      if (name.endsWith(".tsx")) files.push(join(MINI_CARDS, name));
    }
  }
  return files;
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
