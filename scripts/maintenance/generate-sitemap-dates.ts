import {
  CASE_STUDY_DETAIL_SHARED_SOURCES,
  BLOG_DETAIL_SHARED_SOURCES,
  METHODOLOGY_CHANGELOG_SHARED_SOURCES,
  METHODOLOGY_CHANGELOG_ENTRY_SOURCES,
  SCORING_CHANGELOG_CONTENT_SOURCES,
  CHAIN_PROFILE_SOURCES,
  PEG_HUB_SOURCES,
  TAXONOMY_SOURCES,
  GIT_DATE_SCAN_PATHS,
} from "../lib/sitemap-source-paths.mts";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import { assertFullGitHistory } from "../lib/git-history.mts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";
import {
  collectStablecoinDetailDates,
  latestIso,
  STABLECOIN_DETAIL_CONTENT_REVISED_AT,
} from "../lib/sitemap-detail-dates";
import { CASE_STUDY_LIST } from "../../src/lib/case-studies";
import { BLOG_POSTS } from "../../src/data/blog";
import {
  ALL_PEG_SLUGS,
  countStablecoinsByChain,
  MIN_INDEXABLE_CHAIN_STABLECOINS,
  selectPegHubCurrencies,
  selectStablecoinTaxonomyCohorts,
} from "../../src/lib/stablecoin-taxonomy-urls";
import { getActiveChainIds } from "../../shared/lib/chains";
import {
  METHODOLOGY_CHANGELOG_REGISTRY,
} from "../../shared/lib/methodology-versions/registry";
import {
  isActiveStablecoinMeta,
  isPreLaunchStablecoinMeta,
} from "../../shared/lib/stablecoins/status";
import type { PegCurrency } from "../../shared/types/core";
import type { StablecoinMeta } from "../../shared/types/stablecoin-meta-schemas";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const APP_DIR = join(__dirname, "../../src/app");
const CASE_STUDY_CONTENT_DIR = join(__dirname, "../../src/lib/case-studies");
const BLOG_POSTS_DIR = join(__dirname, "../../src/data/blog/posts");
const OUTPUT = join(__dirname, "../../src/generated/sitemap-dates.json");
const OUTPUT_TYPES = join(__dirname, "../../src/generated/sitemap-dates.json.d.ts");

const GIT_LOG_MARKER = "--PHAROS-SITEMAP-COMMIT--";

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
    // A commit carrying this exact message line changed no page content (a
    // refactor of a date source), so it must not move a published date.
    ["log", "--invert-grep", "--grep=^Sitemap-Date: unchanged$", `--format=${GIT_LOG_MARKER}%aI`, "--name-only", "--", ...GIT_DATE_SCAN_PATHS],
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
  const date = index.fileDates.get(gitPath) ?? findDirectoryLastModified(index, gitPath);
  if (date) return date;
  // Never fall back to filesystem mtime: it is checkout time, so a fresh clone
  // would advance every affected route without an editorial change.
  throw new Error(
    `[sitemap-dates] No Git history for ${gitPath}. Commit it, or add its path to ` +
      "GIT_DATE_SCAN_PATHS and SITEMAP_COMMIT_DERIVED_SOURCE_PATHS.",
  );
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function walkPages(dir: string, prefix: string, dates: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Skip dynamic route segments (e.g. [id], [chain])
    if (entry.name.startsWith("[")) continue;
    const subDir = join(dir, entry.name);
    const routePath = `${prefix}${entry.name}/`;
    const pagePath = join(subDir, "page.tsx");
    let hasPage = true;
    try {
      statSync(pagePath);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      hasPage = false;
    }
    if (hasPage) dates[routePath] = getLastModified(pagePath);
    walkPages(subDir, routePath, dates);
  }
}

function addStablecoinDetailDates(
  dates: Record<string, string>,
  entries: ReturnType<typeof loadPerCoinStablecoinEntries>,
): void {
  Object.assign(
    dates,
    collectStablecoinDetailDates(
      entries,
      getLastModified,
      STABLECOIN_DETAIL_CONTENT_REVISED_AT,
      REPO_ROOT,
    ),
  );
}

function addCaseStudyDates(dates: Record<string, string>): void {
  const sharedLastModified = latestIso(...CASE_STUDY_DETAIL_SHARED_SOURCES.map((path) => getLastModified(join(REPO_ROOT, path))));

  for (const study of CASE_STUDY_LIST) {
    const contentPath = join(CASE_STUDY_CONTENT_DIR, `${study.slug}.json`);
    dates[`/learn/case-studies/${study.slug}/`] = latestIso(getLastModified(contentPath), sharedLastModified);
  }

  dates["/learn/case-studies/"] = latestIso(
    getLastModified(join(APP_DIR, "learn/case-studies/page.tsx")),
    getLastModified(CASE_STUDY_CONTENT_DIR),
  );
}

function addBlogDates(dates: Record<string, string>): void {
  const sharedLastModified = latestIso(...BLOG_DETAIL_SHARED_SOURCES.map((path) => getLastModified(join(REPO_ROOT, path))));

  for (const post of BLOG_POSTS) {
    const contentPath = join(BLOG_POSTS_DIR, `${post.slug}.md`);
    dates[`/blog/${post.slug}/`] = latestIso(getLastModified(contentPath), sharedLastModified);
  }
}

function addMethodologyChangelogDates(dates: Record<string, string>): void {
  const sharedLastModified = latestIso(...METHODOLOGY_CHANGELOG_SHARED_SOURCES.map((path) => getLastModified(join(REPO_ROOT, path))));

  for (const changelog of METHODOLOGY_CHANGELOG_REGISTRY) {
    const sources = [METHODOLOGY_CHANGELOG_ENTRY_SOURCES[changelog.key]];
    if (changelog.key === "safety-score") sources.push(...SCORING_CHANGELOG_CONTENT_SOURCES);
    dates[changelog.publicPath] = latestIso(sharedLastModified, ...sources.map((path) => getLastModified(join(REPO_ROOT, path))));
  }
}

function addChainProfileDates(dates: Record<string, string>, activeCoins: readonly StablecoinMeta[]): void {
  const sharedLastModified = latestIso(...CHAIN_PROFILE_SOURCES.map((path) => getLastModified(join(REPO_ROOT, path))));
  const countsByChain = countStablecoinsByChain(activeCoins);
  for (const chainId of getActiveChainIds()) {
    if ((countsByChain.get(chainId) ?? 0) >= MIN_INDEXABLE_CHAIN_STABLECOINS) {
      dates[`/chains/${chainId}/`] = sharedLastModified;
    }
  }
}

function addPegHubDates(
  dates: Record<string, string>,
  activeCoins: readonly StablecoinMeta[],
  preLaunchCoins: readonly StablecoinMeta[],
): void {
  const sharedLastModified = latestIso(...PEG_HUB_SOURCES.map((path) => getLastModified(join(REPO_ROOT, path))));
  const { activePegCurrencies, preLaunchHubPegCurrencies } = selectPegHubCurrencies({
    active: activeCoins,
    preLaunch: preLaunchCoins,
  });
  for (const peg of [...activePegCurrencies, ...preLaunchHubPegCurrencies]) {
    const slug = ALL_PEG_SLUGS[peg as PegCurrency];
    if (slug) dates[`/stablecoins/${slug}/`] = sharedLastModified;
  }
}

function addTaxonomyDates(dates: Record<string, string>, activeCoins: readonly StablecoinMeta[]): void {
  const sharedLastModified = latestIso(...TAXONOMY_SOURCES.map((path) => getLastModified(join(REPO_ROOT, path))));
  const cohorts = selectStablecoinTaxonomyCohorts(activeCoins);
  for (const kind of ["governance", "backing", "infrastructure"] as const) {
    for (const { href } of cohorts[kind]) {
      const routeLastModified = getLastModified(join(APP_DIR, "stablecoins", kind, `[${kind}]`));
      dates[href] = latestIso(sharedLastModified, routeLastModified);
    }
  }
}

export interface GenerateSitemapDatesOptions {
  /** Pass `--check` semantics: verify the committed artifact instead of writing. */
  check?: boolean;
  /**
   * Re-read the Git history instead of reusing the process-wide index. The CLI
   * reads history once; tests call the generator repeatedly with scripted logs.
   */
  freshGitDateIndex?: boolean;
  /** Pre-loaded per-coin catalog entries; the CLI loads them from the repository. */
  entries?: ReturnType<typeof loadPerCoinStablecoinEntries>;
}

export function generateSitemapDates(options: GenerateSitemapDatesOptions = {}): Record<string, string> {
  if (options.freshGitDateIndex) gitDateIndex = undefined;

  const entries = options.entries ?? loadPerCoinStablecoinEntries(REPO_ROOT);
  const coins = entries.map((entry) => entry.coin);
  const activeCoins = coins.filter(isActiveStablecoinMeta);
  const preLaunchCoins = coins.filter(isPreLaunchStablecoinMeta);

  const dates: Record<string, string> = {};
  walkPages(APP_DIR, "/", dates);
  // walkPages only descends into directories; the root page owns "/".
  dates["/"] = getLastModified(join(APP_DIR, "page.tsx"));
  addStablecoinDetailDates(dates, entries);
  addCaseStudyDates(dates);
  addBlogDates(dates);
  addMethodologyChangelogDates(dates);
  addChainProfileDates(dates, activeCoins);
  addPegHubDates(dates, activeCoins, preLaunchCoins);
  addTaxonomyDates(dates, activeCoins);

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
    check: options.check ?? false,
    staleMessage:
      "src/generated/sitemap-dates.json is out of date. Run `tsx scripts/maintenance/generate-sitemap-dates.ts`.",
    currentMessage: `Sitemap dates are current for ${Object.keys(dates).length} pages`,
    writtenMessage: `Generated sitemap dates for ${Object.keys(dates).length} pages`,
  });
  return dates;
}

function main(): void {
  assertFullGitHistory("sitemap-dates");
  generateSitemapDates({ check: process.argv.includes("--check") });
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main();
}
