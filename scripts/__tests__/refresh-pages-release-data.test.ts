import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshPagesReleaseData, type ReleaseRefreshDependencies } from "../maintenance/refresh-pages-release-data.ts";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), "pages-release-refresh-test-"));
  tempDirs.push(repoRoot);
  mkdirSync(join(repoRoot, "data"));
  mkdirSync(join(repoRoot, "data/depeg-events"));
  mkdirSync(join(repoRoot, "public/datasets"), { recursive: true });
  writeFileSync(join(repoRoot, "data/digests.json"), JSON.stringify([{ id: 1 }, { id: 2 }]));
  writeFileSync(join(repoRoot, "data/depeg-events/index.json"), JSON.stringify([{ id: "old" }]));
  writeFileSync(join(repoRoot, "public/datasets/latest.json"), "committed\n");
  const refreshDir = join(repoRoot, "refresh");
  const summaryPath = join(repoRoot, "summary.md");
  return { repoRoot, refreshDir, summaryPath };
}

function ok(output = "") {
  return Promise.resolve({ status: 0, aborted: false, output });
}

describe("Pages release data refresh", () => {
  it("isolates a digest producer failure from successful depeg and dataset refreshes", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const paths = fixture();
    const dependencies: ReleaseRefreshDependencies = {
      digests: () => Promise.resolve({ status: 7, aborted: false, output: "digest failed\n" }),
      depegEvents: ({ outputPath }) => {
        writeFileSync(outputPath!, JSON.stringify([{ id: "new" }]));
        return ok("depeg ok\n");
      },
      publicDatasets: () => ok("datasets ok\n"),
      rollbackPublicDatasets: vi.fn(() => ok()),
    };

    const result = await refreshPagesReleaseData({
      dependencies,
      env: { GITHUB_STEP_SUMMARY: paths.summaryPath, NODE_ENV: "test" },
      refreshDir: paths.refreshDir,
      repoRoot: paths.repoRoot,
    });

    expect(result.digests.ok).toBe(false);
    expect(result.depegEvents.ok).toBe(true);
    expect(result.publicDatasets.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(paths.repoRoot, "data/digests.json"), "utf8"))).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(paths.repoRoot, "data/depeg-events/index.json"), "utf8"))).toEqual([{ id: "new" }]);
    expect(readFileSync(paths.summaryPath, "utf8")).toContain("- Digest refresh: false (2 entries)");
  });

  it("rejects a successful digest refresh when its row count shrinks", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const paths = fixture();
    const result = await refreshPagesReleaseData({
      dependencies: {
        digests: ({ outputPath }) => {
          writeFileSync(outputPath!, JSON.stringify([{ id: 1 }]));
          return ok();
        },
        depegEvents: () => ok(),
        publicDatasets: () => ok(),
      },
      env: { NODE_ENV: "test" },
      refreshDir: paths.refreshDir,
      repoRoot: paths.repoRoot,
    });

    expect(result.digests).toMatchObject({ ok: false, refreshedCount: 1, shrinkRejected: true });
    expect(JSON.parse(readFileSync(join(paths.repoRoot, "data/digests.json"), "utf8"))).toHaveLength(2);
  });

  it("rolls public datasets back without undoing successful snapshot refreshes", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const paths = fixture();
    const datasetPath = join(paths.repoRoot, "public/datasets/latest.json");
    const rollback = vi.fn(() => {
      writeFileSync(datasetPath, "committed\n");
      return ok("rolled back\n");
    });
    const result = await refreshPagesReleaseData({
      dependencies: {
        digests: ({ outputPath }) => {
          writeFileSync(outputPath!, JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]));
          return ok();
        },
        depegEvents: ({ outputPath }) => {
          writeFileSync(outputPath!, JSON.stringify([{ id: "new" }]));
          return ok();
        },
        publicDatasets: () => {
          writeFileSync(datasetPath, "partial\n");
          return Promise.resolve({ status: 1, aborted: false, output: "dataset failed\n" });
        },
        rollbackPublicDatasets: rollback,
      },
      env: { NODE_ENV: "test" },
      refreshDir: paths.refreshDir,
      repoRoot: paths.repoRoot,
    });

    expect(rollback).toHaveBeenCalledOnce();
    expect(result.publicDatasets).toEqual({ ok: false, rolledBack: true });
    expect(readFileSync(datasetPath, "utf8")).toBe("committed\n");
    expect(JSON.parse(readFileSync(join(paths.repoRoot, "data/digests.json"), "utf8"))).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(paths.repoRoot, "data/depeg-events/index.json"), "utf8"))).toEqual([{ id: "new" }]);
  });
  it.each(["digests", "depegEvents"] as const)("isolates a rejected %s promise and persists the result", async (failed) => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const paths = fixture();
    const digestPath = join(paths.repoRoot, "data/digests.json");
    const depegPath = join(paths.repoRoot, "data/depeg-events/index.json");
    const failedPath = failed === "digests" ? digestPath : depegPath;
    const original = readFileSync(failedPath);
    const datasetPath = join(paths.repoRoot, "public/datasets/latest.json");
    const resultPath = join(paths.repoRoot, "custom-result.json");
    const result = await refreshPagesReleaseData({
      dependencies: {
        digests: async ({ outputPath }) => {
          writeFileSync(outputPath!, JSON.stringify([{ id: 3 }, { id: 4 }]));
          if (failed === "digests") throw new Error("producer sentinel");
          return ok();
        },
        depegEvents: async ({ outputPath }) => {
          writeFileSync(outputPath!, JSON.stringify([{ id: "new" }]));
          if (failed === "depegEvents") throw new Error("producer sentinel");
          return ok();
        },
        publicDatasets: () => {
          writeFileSync(datasetPath, "refreshed\n");
          return ok();
        },
      },
      env: { NODE_ENV: "test" },
      refreshDir: paths.refreshDir,
      repoRoot: paths.repoRoot,
      resultPath,
    });
    expect(result[failed].ok).toBe(false);
    expect(result[failed === "digests" ? "depegEvents" : "digests"].ok).toBe(true);
    expect(readFileSync(failedPath)).toEqual(original);
    expect(JSON.parse(readFileSync(failed === "digests" ? depegPath : digestPath, "utf8")))
      .toEqual(failed === "digests" ? [{ id: "new" }] : [{ id: 3 }, { id: 4 }]);
    expect(result.publicDatasets).toEqual({ ok: true, rolledBack: false });
    expect(readFileSync(datasetPath, "utf8")).toBe("refreshed\n");
    expect(result.resultPath).toBe(resultPath);
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual(result);
    expect(readFileSync(join(paths.refreshDir, failed === "digests" ? "digest.log" : "depeg.log"), "utf8"))
      .toContain("producer sentinel");
  });

  it("reports a failed rollback without claiming the partial dataset was restored", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const paths = fixture();
    const datasetPath = join(paths.repoRoot, "public/datasets/latest.json");
    const result = await refreshPagesReleaseData({
      dependencies: {
        digests: () => ok(),
        depegEvents: () => ok(),
        publicDatasets: () => {
          writeFileSync(datasetPath, "partial\n");
          return Promise.resolve({ status: 1, aborted: false });
        },
        rollbackPublicDatasets: () => Promise.resolve({ status: 2, aborted: false, output: "rollback sentinel\n" }),
      },
      env: { NODE_ENV: "test" },
      refreshDir: paths.refreshDir,
      repoRoot: paths.repoRoot,
    });
    expect(result.publicDatasets).toEqual({ ok: false, rolledBack: false });
    expect(readFileSync(datasetPath, "utf8")).toBe("partial\n");
    expect(JSON.parse(readFileSync(result.resultPath, "utf8"))).toEqual(result);
    expect(readFileSync(join(paths.refreshDir, "datasets.log"), "utf8")).toContain("rollback sentinel");
  });
});
