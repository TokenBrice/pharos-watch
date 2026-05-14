/* eslint-disable security/detect-non-literal-fs-filename -- repo-local build script reads checked-in page files under the repository root only. */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { syncGeneratedArtifacts } from "./lib/generated-artifacts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(__dirname, "../src/app");
const OUTPUT = join(__dirname, "../src/generated/sitemap-dates.json");
const CHECK_MODE = process.argv.includes("--check");

function getLastModified(pagePath: string): string {
  try {
    return (
      execFileSync("git", ["log", "-1", "--format=%aI", "--", pagePath], { encoding: "utf-8" }).trim() ||
      statSync(pagePath).mtime.toISOString()
    );
  } catch {
    return statSync(pagePath).mtime.toISOString();
  }
}

function walkPages(dir: string, prefix: string, dates: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Skip dynamic route segments (e.g. [id], [chain])
    if (entry.name.startsWith("[")) continue;
    const subDir = join(dir, entry.name);
    const routePath = `${prefix}${entry.name}/`;
    const pagePath = join(subDir, "page.tsx");
    try {
      statSync(pagePath);
      dates[routePath] = getLastModified(pagePath);
    } catch {
      /* no page.tsx in this directory */
    }
    // Recurse into subdirectories for nested routes
    walkPages(subDir, routePath, dates);
  }
}

const dates: Record<string, string> = {};
walkPages(APP_DIR, "/", dates);

syncGeneratedArtifacts({
  artifacts: [{ path: OUTPUT, contents: JSON.stringify(dates, null, 2) + "\n" }],
  check: CHECK_MODE,
  staleMessage: "src/generated/sitemap-dates.json is out of date. Run `tsx scripts/generate-sitemap-dates.ts`.",
  currentMessage: `Sitemap dates are current for ${Object.keys(dates).length} pages`,
  writtenMessage: `Generated sitemap dates for ${Object.keys(dates).length} pages`,
});
