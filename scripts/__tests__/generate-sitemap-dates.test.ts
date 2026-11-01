import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";
import { collectStablecoinDetailDates, STABLECOIN_DETAIL_CONTENT_REVISED_AT } from "../lib/sitemap-detail-dates";
import { SITEMAP_COMMIT_DERIVED_SOURCE_PATHS } from "../lib/sitemap-source-paths.mts";
import { BLOG_POSTS } from "../../src/data/blog";
import { getIndexableChainIds } from "../../src/lib/chain-indexing";
import { PEG_HUB_PEGS, PEG_HUB_SLUGS } from "../../src/lib/peg-landing";
import { ALL_STABLECOIN_TAXONOMY_PAGES } from "../../src/lib/stablecoin-taxonomy";

const generator = vi.hoisted(() => ({
  gitLog: "",
  gitLogArgs: [] as string[],
  mtime: new Date("2026-01-01T00:00:00.000Z"),
  written: null as Record<string, string> | null,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn((file: string, args: readonly string[], options?: object) => {
      if (file === "git" && args[0] === "log") {
        generator.gitLogArgs = [...args];
        return generator.gitLog;
      }
      return actual.execFileSync(file, args, options as never);
    }),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    // Every stat reports the scenario's checkout time; real type bits remain.
    statSync: vi.fn((path: string, options?: object) => {
      const stats = actual.statSync(path, options as never);
      if (stats) Object.assign(stats, { mtime: generator.mtime, mtimeMs: generator.mtime.getTime() });
      return stats;
    }),
  };
});

vi.mock("../lib/git-history.mts", () => ({ assertFullGitHistory: () => {} }));

vi.mock("../lib/generated-artifacts", () => ({
  syncGeneratedArtifacts: ({ artifacts }: { artifacts: { path: string; contents: string }[] }) => {
    const json = artifacts.find((artifact) => artifact.path.endsWith("sitemap-dates.json"));
    generator.written = json ? (JSON.parse(json.contents) as Record<string, string>) : null;
  },
}));

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const FLOOR_DATE = "2026-01-01T00:00:00.000Z";
const SIDECAR_EDIT_DATE = "2026-09-21T00:00:00.000Z";
const RESERVES_SIDECAR_PREFIX = "shared/data/stablecoins/domains/reserves/";

const entries = loadPerCoinStablecoinEntries(REPO_ROOT);

const reservesSidecars = new Set(
  entries.flatMap((entry) => (entry.sidecarFiles ?? []).filter((file) => file.startsWith(RESERVES_SIDECAR_PREFIX))),
);

describe("stablecoin detail sitemap dates", () => {
  it("advances exactly the pages whose reserves sidecar is the newest source", () => {
    const edited = new Set([...reservesSidecars].map((file) => join(REPO_ROOT, file)));
    const dates = collectStablecoinDetailDates(
      entries,
      (absolutePath) => (edited.has(absolutePath) ? SIDECAR_EDIT_DATE : FLOOR_DATE),
      FLOOR_DATE,
      REPO_ROOT,
    );

    const advanced = entries.filter((entry) => dates[`/stablecoin/${entry.id}/`] === SIDECAR_EDIT_DATE);
    expect(advanced.map((entry) => entry.id)).toEqual(
      entries
        .filter((entry) => (entry.sidecarFiles ?? []).some((file) => reservesSidecars.has(file)))
        .map((entry) => entry.id),
    );
    expect(advanced.length).toBeGreaterThan(0);
    expect(advanced.length).toBeLessThan(entries.length);
  });

  it("keeps one page per catalog coin, floored by the explicit content revision date", () => {
    const dates = collectStablecoinDetailDates(entries, () => FLOOR_DATE, SIDECAR_EDIT_DATE, REPO_ROOT);

    expect(Object.keys(dates).sort()).toEqual(entries.map((entry) => `/stablecoin/${entry.id}/`).sort());
    expect(new Set(Object.values(dates))).toEqual(new Set([SIDECAR_EDIT_DATE]));
  });

  it("moves only the edited coin once its own source postdates the content revision", () => {
    const [edited] = entries;
    const laterEdit = new Date(Date.parse(STABLECOIN_DETAIL_CONTENT_REVISED_AT) + 86_400_000).toISOString();
    const editedFile = join(REPO_ROOT, edited.file);
    const dates = collectStablecoinDetailDates(
      entries,
      (absolutePath) => (absolutePath === editedFile ? laterEdit : FLOOR_DATE),
      STABLECOIN_DETAIL_CONTENT_REVISED_AT,
      REPO_ROOT,
    );

    expect(dates[`/stablecoin/${edited.id}/`]).toBe(laterEdit);
    const others = new Set(entries.slice(1).map((entry) => dates[`/stablecoin/${entry.id}/`]));
    expect(others).toEqual(new Set([STABLECOIN_DETAIL_CONTENT_REVISED_AT]));
  });

  it("pins the shared-content revision to a valid, explicit UTC date", () => {
    expect(STABLECOIN_DETAIL_CONTENT_REVISED_AT).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    expect(Number.isFinite(Date.parse(STABLECOIN_DETAIL_CONTENT_REVISED_AT))).toBe(true);
  });
});

const GIT_MARKER = "--PHAROS-SITEMAP-COMMIT--";
const BASE_COMMIT = "2026-02-01T00:00:00+00:00";
const LATER_COMMIT = "2026-09-30T12:00:00+00:00";
const SCHEMA_PATH = "shared/types/editorial-content.ts";
const STUDY_PATH = "src/lib/case-studies/usdc-svb-2023.json";
const BLOG_INDEX_PATH = "src/data/blog/index.ts";
const BLOG_RENDERER_PATH = "src/app/blog/[slug]/page.tsx";
const BLOG_POST_PATHS = BLOG_POSTS.map((post) => `src/data/blog/posts/${post.slug}.md`);
const CHAIN_CONTENT_PATH = "src/app/chains/static-chain-content.ts";
const PEG_TAXONOMY_PATH = "src/lib/peg-taxonomy.ts";
const TAXONOMY_PAGE_PATH = "src/app/stablecoins/taxonomy-page.tsx";

async function scannedHistoryFiles(): Promise<string[]> {
  const { execFileSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const scanPaths = [
    "src/app",
    "src/lib/case-studies",
    "src/lib/chain-indexing.ts",
    "src/lib/peg-hub-content.ts",
    "src/lib/peg-landing.ts",
    "src/lib/peg-taxonomy.ts",
    "src/lib/stablecoin-taxonomy-urls.ts",
    "src/lib/stablecoin-taxonomy.ts",
    "src/data/blog",
    SCHEMA_PATH,
    "shared/data/stablecoins/coins",
    "shared/data/stablecoins/domains",
    "shared/data/methodology-changelogs",
  ];
  // Every path with history, including deleted shared renderers the generator still dates.
  const history = String(execFileSync("git", ["log", "--format=", "--name-only", "--", ...scanPaths], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  }));
  return [...new Set(history.split("\n").filter(Boolean))];
}

/** Newest-first `git log --name-only` output: `edited` files at LATER, the rest at BASE. */
function gitLogFor(files: readonly string[], edited: readonly string[] = []): string {
  const rest = files.filter((file) => !edited.includes(file));
  const commits = edited.length > 0 ? [[LATER_COMMIT, edited] as const, [BASE_COMMIT, rest] as const] : [[BASE_COMMIT, rest] as const];
  return commits.map(([date, paths]) => `${GIT_MARKER}${date}\n\n${paths.join("\n")}\n`).join("\n");
}

async function runGenerator({ gitLog, mtime }: { gitLog: string; mtime: string }): Promise<Record<string, string>> {
  generator.gitLog = gitLog;
  generator.mtime = new Date(mtime);
  generator.written = null;
  vi.resetModules();
  await import("../maintenance/generate-sitemap-dates.ts");
  expect(generator.written).not.toBeNull();
  return generator.written!;
}

function changedRoutes(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(after).filter((route) => after[route] !== before[route]).sort();
}

describe("generated sitemap dates are independent of checkout time", () => {
  let files: string[] = [];

  beforeAll(async () => {
    files = await scannedHistoryFiles();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("declares and scans the shared case-study schema", async () => {
    expect(SITEMAP_COMMIT_DERIVED_SOURCE_PATHS).toContain(SCHEMA_PATH);
    expect(files).toContain(SCHEMA_PATH);
    await runGenerator({ gitLog: gitLogFor(files), mtime: "2026-10-26T19:23:19.000Z" });
    expect(generator.gitLogArgs).toContain(SCHEMA_PATH);
  });

  it("produces identical output for two different checkout times", async () => {
    const first = await runGenerator({ gitLog: gitLogFor(files), mtime: "2026-03-01T00:00:00.000Z" });
    const second = await runGenerator({ gitLog: gitLogFor(files), mtime: "2026-10-27T09:00:00.000Z" });
    expect(second).toEqual(first);
    expect(first["/learn/case-studies/usdc-svb-2023/"]).toBe(BASE_COMMIT);
  });

  it("fails closed when a tracked route source has no Git history", async () => {
    const withoutHub = files.filter((file) => file !== "src/app/learn/case-studies/page.tsx");
    await expect(runGenerator({ gitLog: gitLogFor(withoutHub), mtime: "2026-10-27T09:00:00.000Z" })).rejects.toThrow(
      /No Git history for src\/app\/learn\/case-studies\/page\.tsx/,
    );
  });

  it("advances only the edited study and the hub for a single case-study edit", async () => {
    const baseline = await runGenerator({ gitLog: gitLogFor(files), mtime: "2026-10-27T09:00:00.000Z" });
    const edited = await runGenerator({ gitLog: gitLogFor(files, [STUDY_PATH]), mtime: "2026-10-27T09:00:00.000Z" });
    expect(changedRoutes(baseline, edited)).toEqual(["/learn/case-studies/", "/learn/case-studies/usdc-svb-2023/"]);
    expect(edited["/learn/case-studies/usdc-svb-2023/"]).toBe(LATER_COMMIT);
  });

  it("advances every case-study detail page for a shared schema edit", async () => {
    const baseline = await runGenerator({ gitLog: gitLogFor(files), mtime: "2026-10-27T09:00:00.000Z" });
    const edited = await runGenerator({ gitLog: gitLogFor(files, [SCHEMA_PATH]), mtime: "2026-10-27T09:00:00.000Z" });
    const changed = changedRoutes(baseline, edited);
    expect(changed.length).toBeGreaterThan(1);
    expect(changed.every((route) => /^\/learn\/case-studies\/[^/]+\/$/.test(route))).toBe(true);
    expect(changed).not.toContain("/learn/case-studies/");
  });

  it("does not re-stamp blog posts for a registry or site-wide metadata edit", async () => {
    const baseline = await runGenerator({ gitLog: gitLogFor(files), mtime: "2026-10-27T09:00:00.000Z" });
    const registryEdit = await runGenerator({
      gitLog: gitLogFor(files, [BLOG_INDEX_PATH]),
      mtime: "2026-10-27T09:00:00.000Z",
    });
    expect(changedRoutes(baseline, registryEdit).filter((route) => /^\/blog\/[^/]+\/$/.test(route))).toEqual([]);

    const metadataPath = "src/lib/page-metadata.ts";
    const metadataEdit = await runGenerator({
      gitLog: gitLogFor([...files, metadataPath], [metadataPath]),
      mtime: "2026-10-27T09:00:00.000Z",
    });
    expect(changedRoutes(baseline, metadataEdit).filter((route) => /^\/blog\/[^/]+\/$/.test(route))).toEqual([]);
  });

  it("dates each post from its own markdown and the shared renderer only", async () => {
    const baseline = await runGenerator({ gitLog: gitLogFor(files), mtime: "2026-10-27T09:00:00.000Z" });
    const editedPost = BLOG_POST_PATHS[0];
    const postEdit = await runGenerator({
      gitLog: gitLogFor(files, [editedPost]),
      mtime: "2026-10-27T09:00:00.000Z",
    });
    expect(changedRoutes(baseline, postEdit)).toEqual([`/blog/${BLOG_POSTS[0].slug}/`]);

    const rendererEdit = await runGenerator({
      gitLog: gitLogFor(files, [BLOG_RENDERER_PATH]),
      mtime: "2026-10-27T09:00:00.000Z",
    });
    expect(changedRoutes(baseline, rendererEdit).sort()).toEqual(
      BLOG_POSTS.map((post) => `/blog/${post.slug}/`).sort(),
    );
  });

  it("gives the root route its own Git date", async () => {
    const baseline = await runGenerator({ gitLog: gitLogFor(files), mtime: "2026-10-27T09:00:00.000Z" });
    expect(baseline["/"]).toBe(BASE_COMMIT);
  });

  it("advances every indexable chain profile for a shared chain-content edit", async () => {
    const baseline = await runGenerator({ gitLog: gitLogFor(files), mtime: "2026-10-27T09:00:00.000Z" });
    const edited = await runGenerator({ gitLog: gitLogFor(files, [CHAIN_CONTENT_PATH]), mtime: "2026-10-27T09:00:00.000Z" });
    const changed = changedRoutes(baseline, edited);

    expect(changed.sort()).toEqual(
      getIndexableChainIds().map((chainId) => `/chains/${chainId}/`).sort(),
    );
    expect(changed.every((route) => edited[route] === LATER_COMMIT)).toBe(true);
  });

  it("advances every peg hub for a shared peg-taxonomy edit", async () => {
    const baseline = await runGenerator({ gitLog: gitLogFor(files), mtime: "2026-10-27T09:00:00.000Z" });
    const edited = await runGenerator({ gitLog: gitLogFor(files, [PEG_TAXONOMY_PATH]), mtime: "2026-10-27T09:00:00.000Z" });
    const expected = PEG_HUB_PEGS
      .map((peg) => PEG_HUB_SLUGS[peg])
      .filter((slug): slug is string => Boolean(slug))
      .map((slug) => `/stablecoins/${slug}/`);

    expect(changedRoutes(baseline, edited).sort()).toEqual(expected.sort());
  });

  it("advances every taxonomy cohort page for a shared taxonomy-renderer edit", async () => {
    const baseline = await runGenerator({ gitLog: gitLogFor(files), mtime: "2026-10-27T09:00:00.000Z" });
    const edited = await runGenerator({ gitLog: gitLogFor(files, [TAXONOMY_PAGE_PATH]), mtime: "2026-10-27T09:00:00.000Z" });
    const expected = ALL_STABLECOIN_TAXONOMY_PAGES.map((page) => page.href);

    expect(changedRoutes(baseline, edited).sort()).toEqual(expected.sort());
  });
});
