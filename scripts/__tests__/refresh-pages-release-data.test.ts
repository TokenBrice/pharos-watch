import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshPagesReleaseData, shouldFailReleaseRefresh, type ReleaseRefreshDependencies } from "../maintenance/refresh-pages-release-data.ts";
import { SnapshotIntegrityError } from "../lib/sync-from-api";

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
  mkdirSync(join(repoRoot, "src/lib/datasets"), { recursive: true });
  writeFileSync(join(repoRoot, "public/_redirects"), [
    "/candidate-authored /keep-me 301",
    "# BEGIN GENERATED PUBLIC DATASET ALIASES",
    "/datasets/top-stablecoins/latest.json /datasets/top-stablecoins/2026-10-18.json 200",
    "# END GENERATED PUBLIC DATASET ALIASES",
    "/another-authored /also-keep 302",
    "",
  ].join("\n"));
  writeFileSync(join(repoRoot, "src/lib/datasets/public-dataset-current.ts"),
    'import current from "../../../public/datasets/top-stablecoins/2026-10-18.json";\nexport { current };\n');
  const refreshDir = join(repoRoot, "refresh");
  const summaryPath = join(repoRoot, "summary.md");
  return { repoRoot, refreshDir, summaryPath };
}

function ok(output = "") {
  return Promise.resolve({ status: 0, aborted: false, output });
}

/**
 * Both snapshot producers must be in flight before either is allowed to
 * finish. A sequential runner would leave the first producer waiting on this
 * gate forever, so the case cannot pass without real concurrency.
 */
function concurrencyBarrier(parties: number) {
  let arrived = 0;
  let release = (): void => {};
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });

  return async () => {
    arrived += 1;
    if (arrived >= parties) release();
    await gate;
  };
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

  it("retains every committed depeg shard when pagination fails its integrity ceiling", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const paths = fixture();
    const shardPath = join(paths.repoRoot, "data/depeg-events/2025.json");
    writeFileSync(shardPath, JSON.stringify([{ id: "historical" }]));
    const indexPath = join(paths.repoRoot, "data/depeg-events/index.json");
    const originalIndex = readFileSync(indexPath, "utf8");
    const originalShard = readFileSync(shardPath, "utf8");
    const result = await refreshPagesReleaseData({
      dependencies: {
        digests: () => ok(),
        depegEvents: async () => {
          throw new SnapshotIntegrityError("Depeg pagination reached its safety ceiling with an outstanding cursor");
        },
        publicDatasets: () => {
          expect(readFileSync(indexPath, "utf8")).toBe(originalIndex);
          expect(readFileSync(shardPath, "utf8")).toBe(originalShard);
          return ok();
        },
      },
      env: { NODE_ENV: "test" },
      refreshDir: paths.refreshDir,
      repoRoot: paths.repoRoot,
    });

    expect(result.depegEvents.ok).toBe(false);
    expect(readFileSync(indexPath, "utf8")).toBe(originalIndex);
    expect(readFileSync(shardPath, "utf8")).toBe(originalShard);
    expect(readFileSync(join(paths.refreshDir, "depeg.log"), "utf8")).toContain("using committed depeg snapshot");
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

  it.each(["dated files", "aliases", "current module"] as const)(
    "restores the complete pre-refresh bundle after failure following %s",
    async (boundary) => {
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const paths = fixture();
      const topicDir = join(paths.repoRoot, "public/datasets/top-stablecoins");
      mkdirSync(topicDir);
      const oldFiles = ["2026-07-01.json", "2026-10-18.csv", "2026-10-18.json", "2026-10-18.ndjson"];
      for (const name of oldFiles) writeFileSync(join(topicDir, name), `original ${name}\n`);
      const redirectsPath = join(paths.repoRoot, "public/_redirects");
      const currentPath = join(paths.repoRoot, "src/lib/datasets/public-dataset-current.ts");
      const previousRedirects = readFileSync(redirectsPath);
      const previousCurrent = readFileSync(currentPath);
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
          publicDatasets: async () => {
            // Model dated writes, same-day replacement and retention pruning before alias/import commits.
            for (const extension of ["csv", "json", "ndjson"]) {
              writeFileSync(join(topicDir, `2026-10-19.${extension}`), `new ${extension}\n`);
              writeFileSync(join(topicDir, `2026-10-18.${extension}`), "overwritten\n");
            }
            rmSync(join(topicDir, "2026-07-01.json"));
            writeFileSync(join(paths.repoRoot, "public/datasets/latest.json"), "partial\n");
            if (boundary === "dated files") throw new Error("dated write fault");
            writeFileSync(redirectsPath, previousRedirects.toString().replaceAll("2026-10-18", "2026-10-19"));
            if (boundary === "aliases") throw new Error("alias write fault");
            writeFileSync(currentPath, previousCurrent.toString().replaceAll("2026-10-18", "2026-10-19"));
            throw new Error("current module write fault");
          },
        },
        env: { NODE_ENV: "test" },
        refreshDir: paths.refreshDir,
        repoRoot: paths.repoRoot,
      });

      expect(result.publicDatasets).toEqual({ ok: false, rolledBack: true });
      expect(shouldFailReleaseRefresh(result)).toBe(false);
      expect(readdirSync(join(paths.repoRoot, "public/datasets")).sort()).toEqual(["latest.json", "top-stablecoins"]);
      expect(readdirSync(topicDir).sort()).toEqual(oldFiles);
      for (const name of oldFiles) expect(readFileSync(join(topicDir, name), "utf8")).toBe(`original ${name}\n`);
      expect(readFileSync(join(paths.repoRoot, "public/datasets/latest.json"), "utf8")).toBe("committed\n");
      expect(readFileSync(redirectsPath)).toEqual(previousRedirects);
      expect(readFileSync(currentPath)).toEqual(previousCurrent);
      expect(JSON.parse(readFileSync(join(paths.repoRoot, "data/digests.json"), "utf8"))).toHaveLength(3);
      expect(JSON.parse(readFileSync(join(paths.repoRoot, "data/depeg-events/index.json"), "utf8"))).toEqual([{ id: "new" }]);
    },
  );

  it("removes newly created bundle targets when the pre-refresh workspace had none", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const paths = fixture();
    const targets = ["public/datasets", "public/_redirects", "src/lib/datasets/public-dataset-current.ts"];
    for (const target of targets) rmSync(join(paths.repoRoot, target), { recursive: true, force: true });
    const result = await refreshPagesReleaseData({
      dependencies: {
        digests: () => ok(),
        depegEvents: () => ok(),
        publicDatasets: async () => {
          mkdirSync(join(paths.repoRoot, "public/datasets"));
          writeFileSync(join(paths.repoRoot, "public/datasets/new.json"), "partial\n");
          writeFileSync(join(paths.repoRoot, "public/_redirects"), "/new /missing 200\n");
          writeFileSync(join(paths.repoRoot, "src/lib/datasets/public-dataset-current.ts"), "partial\n");
          return { status: 1, aborted: false };
        },
      },
      env: { NODE_ENV: "test" },
      refreshDir: paths.refreshDir,
      repoRoot: paths.repoRoot,
    });
    expect(result.publicDatasets).toEqual({ ok: false, rolledBack: true });
    for (const target of targets) expect(existsSync(join(paths.repoRoot, target))).toBe(false);
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
    expect(shouldFailReleaseRefresh(result)).toBe(true);
    expect(readFileSync(datasetPath, "utf8")).toBe("partial\n");
    expect(JSON.parse(readFileSync(result.resultPath, "utf8"))).toEqual(result);
    expect(readFileSync(join(paths.refreshDir, "datasets.log"), "utf8")).toContain("rollback sentinel");
  });

  it("still blocks release when all producers fail even after a complete dataset rollback", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const paths = fixture();
    const failed = async () => ({ status: 1, aborted: false });
    const result = await refreshPagesReleaseData({
      dependencies: { digests: failed, depegEvents: failed, publicDatasets: failed },
      env: { NODE_ENV: "test" },
      refreshDir: paths.refreshDir,
      repoRoot: paths.repoRoot,
    });
    expect(result.digests.ok).toBe(false);
    expect(result.depegEvents.ok).toBe(false);
    expect(result.publicDatasets).toEqual({ ok: false, rolledBack: true });
    expect(shouldFailReleaseRefresh(result)).toBe(true);
  });

  it("refreshes both snapshots concurrently and defers public datasets until they land", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const paths = fixture();
    const datasetPath = join(paths.repoRoot, "public/datasets/latest.json");
    const bothStarted = concurrencyBarrier(2);
    const order: string[] = [];

    const result = await refreshPagesReleaseData({
      dependencies: {
        digests: async ({ outputPath }) => {
          order.push("digests:start");
          await bothStarted();
          writeFileSync(outputPath!, JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]));
          order.push("digests:settled");
          return ok();
        },
        depegEvents: async ({ outputPath }) => {
          order.push("depeg:start");
          await bothStarted();
          writeFileSync(outputPath!, JSON.stringify([{ id: "new" }]));
          order.push("depeg:settled");
          return ok();
        },
        publicDatasets: () => {
          order.push("datasets:start");
          // Datasets publish whatever the snapshot refreshes already moved into place.
          writeFileSync(datasetPath, JSON.stringify({
            depegEvents: JSON.parse(readFileSync(join(paths.repoRoot, "data/depeg-events/index.json"), "utf8")),
            digests: JSON.parse(readFileSync(join(paths.repoRoot, "data/digests.json"), "utf8")),
          }));
          return ok();
        },
      },
      env: { NODE_ENV: "test" },
      refreshDir: paths.refreshDir,
      repoRoot: paths.repoRoot,
    });

    expect([...order.slice(0, 2)].sort()).toEqual(["depeg:start", "digests:start"]);
    expect(order).toHaveLength(5);
    expect(order[4]).toBe("datasets:start");
    expect(JSON.parse(readFileSync(datasetPath, "utf8"))).toEqual({
      depegEvents: [{ id: "new" }],
      digests: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });
    expect(result.digests).toMatchObject({ ok: true, refreshedCount: 3 });
    expect(result.depegEvents.ok).toBe(true);
    expect(result.publicDatasets).toEqual({ ok: true, rolledBack: false });
  });
});
