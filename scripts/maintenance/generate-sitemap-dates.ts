import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(__dirname, "../../src/app");
const STABLECOIN_COINS_DIR = join(__dirname, "../../shared/data/stablecoins/coins");
const OUTPUT = join(__dirname, "../../src/generated/sitemap-dates.json");
const CHECK_MODE = process.argv.includes("--check");
const STABLECOIN_DETAIL_SHARED_SOURCES = [
  join(__dirname, "../../src/app/stablecoin/[id]/page.tsx"),
  join(__dirname, "../../src/components/stablecoin-detail/static-seo-content.tsx"),
  join(__dirname, "../../src/lib/page-metadata.ts"),
  join(__dirname, "../../src/lib/stablecoin-detail-json-ld.ts"),
];

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

function latestIso(...dates: string[]): string {
  return dates.reduce((latest, candidate) => {
    return new Date(candidate).getTime() > new Date(latest).getTime() ? candidate : latest;
  });
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

function readStablecoinId(filePath: string): string {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { id?: unknown };
  if (typeof parsed.id !== "string" || !parsed.id) {
    throw new Error(`Stablecoin metadata file is missing a string id: ${filePath}`);
  }
  return parsed.id;
}

function addStablecoinDetailDates(dates: Record<string, string>): void {
  const sharedLastModified = latestIso(...STABLECOIN_DETAIL_SHARED_SOURCES.map(getLastModified));

  for (const entry of readdirSync(STABLECOIN_COINS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = join(STABLECOIN_COINS_DIR, entry.name);
    const id = readStablecoinId(filePath);
    dates[`/stablecoin/${id}/`] = latestIso(getLastModified(filePath), sharedLastModified);
  }
}

const dates: Record<string, string> = {};
walkPages(APP_DIR, "/", dates);
addStablecoinDetailDates(dates);

// The mechanism explainer hub date must move when any archetype content
// module under the cluster changes — per-archetype Article JSON-LD sources
// its dateModified from this entry — not only when the hub page.tsx does.
dates["/learn/mechanisms/"] = getLastModified(join(APP_DIR, "learn/mechanisms"));

syncGeneratedArtifacts({
  artifacts: [{ path: OUTPUT, contents: JSON.stringify(dates, null, 2) + "\n" }],
  check: CHECK_MODE,
  staleMessage: "src/generated/sitemap-dates.json is out of date. Run `tsx scripts/maintenance/generate-sitemap-dates.ts`.",
  currentMessage: `Sitemap dates are current for ${Object.keys(dates).length} pages`,
  writtenMessage: `Generated sitemap dates for ${Object.keys(dates).length} pages`,
});
