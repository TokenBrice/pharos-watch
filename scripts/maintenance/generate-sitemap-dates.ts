import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import { assertFullGitHistory } from "../lib/git-history.mts";
import { CASE_STUDY_LIST } from "../../src/lib/case-studies";
import { BLOG_POSTS } from "../../src/data/blog";
import {
  METHODOLOGY_CHANGELOG_REGISTRY,
  type MethodologyChangelogRegistryKey,
} from "../../shared/lib/methodology-versions/registry";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const APP_DIR = join(__dirname, "../../src/app");
const STABLECOIN_COINS_DIR = join(__dirname, "../../shared/data/stablecoins/coins");
const CASE_STUDY_CONTENT_DIR = join(__dirname, "../../src/lib/case-studies");
const BLOG_POSTS_DIR = join(__dirname, "../../src/data/blog/posts");
const OUTPUT = join(__dirname, "../../src/generated/sitemap-dates.json");
const OUTPUT_TYPES = join(__dirname, "../../src/generated/sitemap-dates.json.d.ts");
const CHECK_MODE = process.argv.includes("--check");

assertFullGitHistory("sitemap-dates");
const STABLECOIN_DETAIL_SHARED_SOURCES = [
  join(__dirname, "../../src/app/stablecoin/[id]/page.tsx"),
  join(__dirname, "../../src/components/stablecoin-detail/static-seo-content.tsx"),
  join(__dirname, "../../src/lib/page-metadata.ts"),
  join(__dirname, "../../src/lib/stablecoin-detail-json-ld.ts"),
];
const CASE_STUDY_DETAIL_SHARED_SOURCES = [
  join(__dirname, "../../src/app/learn/case-studies/[slug]/page.tsx"),
  join(__dirname, "../../src/app/learn/case-studies/case-study-body.tsx"),
  join(__dirname, "../../src/app/learn/case-studies/case-study-chart.tsx"),
  join(__dirname, "../../src/app/learn/case-studies/case-study-json-ld.tsx"),
  join(__dirname, "../../src/app/learn/case-studies/case-study-page-shell.tsx"),
  join(__dirname, "../../src/app/learn/case-studies/case-study-timeline.tsx"),
  join(__dirname, "../../src/lib/case-studies/types.ts"),
];
const BLOG_DETAIL_SHARED_SOURCES = [
  join(__dirname, "../../src/app/blog/[slug]/page.tsx"),
  join(__dirname, "../../src/data/blog/index.ts"),
  join(__dirname, "../../src/lib/page-metadata.ts"),
];
const METHODOLOGY_CHANGELOG_SHARED_SOURCES = [
  // This route owns the shared display config as well as dynamic route metadata.
  join(__dirname, "../../src/app/methodology/[slug]/page.tsx"),
];
const METHODOLOGY_CHANGELOG_ENTRY_SOURCES: Record<MethodologyChangelogRegistryKey, string> = {
  "safety-score": join(__dirname, "../../shared/data/methodology-changelogs/safety-score"),
  "depeg-dews": join(__dirname, "../../shared/data/methodology-changelogs/depeg-dews"),
  "depeg-resolver": join(__dirname, "../../shared/data/methodology-changelogs/depeg-resolver"),
  "liquidity-score": join(__dirname, "../../shared/data/methodology-changelogs/liquidity-score"),
  "stability-index": join(__dirname, "../../shared/data/methodology-changelogs/stability-index"),
  "chain-health": join(__dirname, "../../shared/data/methodology-changelogs/chain-health"),
  yield: join(__dirname, "../../shared/data/methodology-changelogs/yield-methodology"),
  "blacklist-tracker": join(__dirname, "../../shared/data/methodology-changelogs/blacklist-tracker"),
  "mint-burn-flow": join(__dirname, "../../shared/data/methodology-changelogs/mint-burn-flow"),
  "pricing-pipeline": join(__dirname, "../../shared/data/methodology-changelogs/pricing-pipeline"),
  "redemption-backstop": join(__dirname, "../../shared/data/methodology-changelogs/redemption-backstop"),
};
const SCORING_CHANGELOG_CONTENT_SOURCES = [
  join(__dirname, "../../src/app/methodology/changelog-content/scoring"),
];

const GIT_LOG_MARKER = "--PHAROS-SITEMAP-COMMIT--";
const GIT_DATE_SCAN_PATHS = [
  "src/app",
  "src/lib/case-studies",
  "src/data/blog",
  "src/components/stablecoin-detail/static-seo-content.tsx",
  "src/lib/page-metadata.ts",
  "src/lib/stablecoin-detail-json-ld.ts",
  "shared/data/stablecoins/coins",
  "shared/data/methodology-changelogs",
];

interface GitDateIndex {
  fileDates: Map<string, string>;
  changedPaths: { path: string; date: string }[];
}

let gitDateIndex: GitDateIndex | undefined;

function toGitPath(path: string): string {
  return relative(REPO_ROOT, path).replaceAll("\\", "/");
}

function loadGitDateIndex(): GitDateIndex {
  const output = execFileSync(
    "git",
    ["log", `--format=${GIT_LOG_MARKER}%aI`, "--name-only", "--", ...GIT_DATE_SCAN_PATHS],
    { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  const fileDates = new Map<string, string>();
  const changedPaths: GitDateIndex["changedPaths"] = [];
  let currentDate: string | null = null;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith(GIT_LOG_MARKER)) {
      currentDate = line.slice(GIT_LOG_MARKER.length);
      continue;
    }
    if (!line || currentDate == null) continue;
    const changedPath = line.replaceAll("\\", "/");
    if (!fileDates.has(changedPath)) fileDates.set(changedPath, currentDate);
    changedPaths.push({ path: changedPath, date: currentDate });
  }

  if (fileDates.size === 0) {
    throw new Error(
      "[sitemap-dates] git log returned no history for the sitemap scan paths. " +
        "Refusing to fall back to filesystem timestamps, which would stamp every route as modified today.",
    );
  }

  return { fileDates, changedPaths };
}

function getGitDateIndex(): GitDateIndex {
  if (gitDateIndex === undefined) {
    gitDateIndex = loadGitDateIndex();
  }
  return gitDateIndex;
}

function findDirectoryLastModified(index: GitDateIndex, gitPath: string): string | null {
  const prefix = gitPath.endsWith("/") ? gitPath : `${gitPath}/`;
  return index.changedPaths.find((entry) => entry.path === gitPath || entry.path.startsWith(prefix))?.date ?? null;
}

function getLastModified(pagePath: string): string {
  const index = getGitDateIndex();
  const gitPath = toGitPath(pagePath);
  const fileDate = index.fileDates.get(gitPath);
  if (fileDate) return fileDate;

  const pageStat = statSync(pagePath);
  if (pageStat.isDirectory()) {
    const directoryDate = findDirectoryLastModified(index, gitPath);
    if (directoryDate) return directoryDate;
  }
  return pageStat.mtime.toISOString();
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
    dates[buildStablecoinUrl(id)] = latestIso(getLastModified(filePath), sharedLastModified);
  }
}

function addCaseStudyDates(dates: Record<string, string>): void {
  const sharedLastModified = latestIso(...CASE_STUDY_DETAIL_SHARED_SOURCES.map(getLastModified));

  for (const study of CASE_STUDY_LIST) {
    const contentPath = join(CASE_STUDY_CONTENT_DIR, `${study.slug}.ts`);
    dates[`/learn/case-studies/${study.slug}/`] = latestIso(getLastModified(contentPath), sharedLastModified);
  }

  dates["/learn/case-studies/"] = latestIso(
    getLastModified(join(APP_DIR, "learn/case-studies/page.tsx")),
    getLastModified(CASE_STUDY_CONTENT_DIR),
  );
}

function addBlogDates(dates: Record<string, string>): void {
  const sharedLastModified = latestIso(...BLOG_DETAIL_SHARED_SOURCES.map(getLastModified));

  for (const post of BLOG_POSTS) {
    const contentPath = join(BLOG_POSTS_DIR, `${post.slug}.md`);
    dates[`/blog/${post.slug}/`] = latestIso(getLastModified(contentPath), sharedLastModified);
  }
}

function addMethodologyChangelogDates(dates: Record<string, string>): void {
  const sharedLastModified = latestIso(...METHODOLOGY_CHANGELOG_SHARED_SOURCES.map(getLastModified));

  for (const changelog of METHODOLOGY_CHANGELOG_REGISTRY) {
    const sources = [METHODOLOGY_CHANGELOG_ENTRY_SOURCES[changelog.key]];
    if (changelog.key === "safety-score") sources.push(...SCORING_CHANGELOG_CONTENT_SOURCES);
    dates[changelog.publicPath] = latestIso(sharedLastModified, ...sources.map(getLastModified));
  }
}

const dates: Record<string, string> = {};
walkPages(APP_DIR, "/", dates);
addStablecoinDetailDates(dates);
addCaseStudyDates(dates);
addBlogDates(dates);
addMethodologyChangelogDates(dates);

// The mechanism explainer hub date must move when any archetype content
// module under the cluster changes — per-archetype Article JSON-LD sources
// its dateModified from this entry — not only when the hub page.tsx does.
dates["/learn/mechanisms/"] = getLastModified(join(APP_DIR, "learn/mechanisms"));

syncGeneratedArtifacts({
  artifacts: [
    { path: OUTPUT, contents: JSON.stringify(dates, null, 2) + "\n" },
    {
      path: OUTPUT_TYPES,
      contents: `/** Auto-generated by scripts/maintenance/generate-sitemap-dates.ts during prebuild. */
declare const sitemapDates: Record<string, string>;
export default sitemapDates;
`,
    },
  ],
  check: CHECK_MODE,
  staleMessage:
    "src/generated/sitemap-dates.json is out of date. Run `tsx scripts/maintenance/generate-sitemap-dates.ts`.",
  currentMessage: `Sitemap dates are current for ${Object.keys(dates).length} pages`,
  writtenMessage: `Generated sitemap dates for ${Object.keys(dates).length} pages`,
});
