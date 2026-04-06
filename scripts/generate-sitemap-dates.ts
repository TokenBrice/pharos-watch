/* eslint-disable security/detect-non-literal-fs-filename -- repo-local build script reads checked-in page files under the repository root only. */

import { execSync } from "node:child_process";
import { readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(__dirname, "../src/app");
const OUTPUT = join(__dirname, "../src/generated/sitemap-dates.json");

function getLastModified(pagePath: string): string {
  try {
    return execSync(`git log -1 --format=%aI -- "${pagePath}"`, { encoding: "utf-8" }).trim() || new Date().toISOString();
  } catch {
    return new Date().toISOString();
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
    } catch { /* no page.tsx in this directory */ }
    // Recurse into subdirectories for nested routes
    walkPages(subDir, routePath, dates);
  }
}

const dates: Record<string, string> = {};
walkPages(APP_DIR, "/", dates);

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(dates, null, 2) + "\n");
console.log(`Generated sitemap dates for ${Object.keys(dates).length} pages`);
