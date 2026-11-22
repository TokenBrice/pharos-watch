import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshPagesReleaseData, shouldFailReleaseRefresh, type ReleaseRefreshDependencies } from "../maintenance/refresh-pages-release-data.ts";
import { SnapshotIntegrityError } from "../lib/sync-from-api";
import * as commandRunner from "../lib/command-runner.mts";
import { localBin } from "../lib/local-bin.mts";
import { PUBLIC_DATASETS_REQUIRE_CURRENT_SAFETY } from "../lib/public-dataset-projections";

const tempDirs: string[] = [];

beforeEach(() => { vi.spyOn(process.stdout, "write").mockImplementation(() => true); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), "pages-release-refresh-test-"));
  tempDirs.push(repoRoot);
  for (const dir of ["data/depeg-events", "public/datasets", "src/lib/datasets"]) mkdirSync(join(repoRoot, dir), { recursive: true });
  writeFileSync(join(repoRoot, "data/digests.json"), JSON.stringify([{ id: 1 }, { id: 2 }]));
  writeFileSync(join(repoRoot, "data/depeg-events/index.json"), JSON.stringify([{ id: "old" }]));
  writeFileSync(join(repoRoot, "public/datasets/latest.json"), "committed\n");
  writeFileSync(join(repoRoot, "public/_redirects"), [
    "/candidate-authored /keep-me 301", "# BEGIN GENERATED PUBLIC DATASET ALIASES",
    "/datasets/top-stablecoins/latest.json /datasets/top-stablecoins/2026-10-18.json 200",
    "# END GENERATED PUBLIC DATASET ALIASES", "/another-authored /also-keep 302", "",
  ].join("\n"));
  writeFileSync(join(repoRoot, "src/lib/datasets/public-dataset-current.ts"),
    'import current from "../../../public/datasets/top-stablecoins/2026-10-18.json";\nexport { current };\n');
  return { repoRoot, refreshDir: join(repoRoot, "refresh"), summaryPath: join(repoRoot, "summary.md") };
}

const ok = (output = "") => Promise.resolve({ status: 0, aborted: false, output });
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v));
const run = (p: ReturnType<typeof fixture>, dependencies: Partial<ReleaseRefreshDependencies>, extra: Partial<Parameters<typeof refreshPagesReleaseData>[0]> = {}) =>
  refreshPagesReleaseData({ ...p, dependencies, env: { NODE_ENV: "test" }, ...extra });
const makeSnapshot = (snapshotDate: string) => ({
  snapshotDate, generatedAt: 1_779_000_000, methodologyVersions: {},
  stablecoins: [{ id: "usdc-circle", name: "USD Coin", symbol: "USDC", pegType: "peggedUSD", pegMechanism: "fiat-backed", price: 1, circulating: { peggedUSD: 1 }, chains: ["ethereum"] }],
  reportCards: null, dews: [], liquidity: [],
});

function concurrencyBarrier(parties: number) {
  let arrived = 0, release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  return async () => { if (++arrived >= parties) release(); await gate; };
}

describe("Pages release data refresh", () => {
  it("requires current Safety before a prior-date release can replace the latest bundle", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-19T12:00:00Z"));
    const spawn = vi.spyOn(commandRunner, "runSpawnCommand").mockResolvedValue({
      status: 1, aborted: false, output: "Safety publication identity does not match the envelope identity\n",
    });
    const p = fixture(), redirects = readFileSync(join(p.repoRoot, "public/_redirects"));
    const result = await run(p, { digests: () => ok(), depegEvents: () => ok() });
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ executable: localBin("tsx"), args: ["scripts/maintenance/generate-public-datasets.ts", "--repoint-current"] }),
      { PUBLIC_DATASETS_DATE: "2026-10-18", [PUBLIC_DATASETS_REQUIRE_CURRENT_SAFETY]: "1" },
    );
    expect(result.publicDatasets).toMatchObject({ ok: false, rolledBack: true, durationMs: expect.any(Number) });
    expect(result.digests.durationMs).toEqual(expect.any(Number));
    expect(result.depegEvents.durationMs).toEqual(expect.any(Number));
    expect(readFileSync(join(p.repoRoot, "public/_redirects"))).toEqual(redirects);
    expect(readFileSync(join(p.repoRoot, "public/datasets/latest.json"), "utf8")).toBe("committed\n");
  });

  it("prefetches immutable snapshots concurrently and falls back cleanly when prefetch fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-19T12:00:00Z"));
    const p = fixture(), barrier = concurrencyBarrier(3), snap = join(p.refreshDir, "prefetched-snapshot.json");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://site-api.pharos.watch/api/snapshots/2026-10-18.json");
      expect(new Headers(init?.headers).get("X-Pharos-Site-Proxy-Secret")).toBe("site-secret");
      await barrier();
      return Response.json(makeSnapshot("2026-10-18"));
    }));
    const spawn = vi.spyOn(commandRunner, "runSpawnCommand").mockImplementation(async () => {
      expect(readJson(join(p.repoRoot, "data/depeg-events/index.json"))).toEqual([{ id: "new" }]);
      return { status: 0, aborted: false, output: "ok\n" };
    });
    const res = await run(p, {
      digests: async () => { await barrier(); return ok(); },
      depegEvents: async ({ outputPath }) => { await barrier(); writeJson(outputPath!, [{ id: "new" }]); return ok(); },
    }, { env: { NODE_ENV: "test", PUBLIC_DATASETS_API_URL: "https://site-api.pharos.watch", SITE_API_SHARED_SECRET: "site-secret" } });
    expect(res.publicDatasets).toMatchObject({ ok: true, rolledBack: false, durationMs: expect.any(Number) });
    expect(existsSync(snap)).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ executable: localBin("tsx"), args: ["scripts/maintenance/generate-public-datasets.ts", "--repoint-current", "--snapshot-file", snap] }),
      { PUBLIC_DATASETS_DATE: "2026-10-18", [PUBLIC_DATASETS_REQUIRE_CURRENT_SAFETY]: "1" },
    );

    const p2 = fixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    spawn.mockClear().mockResolvedValue({ status: 0, aborted: false, output: "fallback\n" });
    const res2 = await run(p2, { digests: () => ok(), depegEvents: () => ok() }, {
      env: { NODE_ENV: "test", PUBLIC_DATASETS_API_URL: "https://site-api.pharos.watch", PUBLIC_DATASETS_DATE: "2026-10-15" },
    });
    expect(res2.publicDatasets.ok).toBe(true);
    expect(existsSync(join(p2.refreshDir, "prefetched-snapshot.json"))).toBe(false);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ executable: localBin("tsx"), args: ["scripts/maintenance/generate-public-datasets.ts"] }),
      { PUBLIC_DATASETS_DATE: "2026-10-15" },
    );
  });

  it("isolates a digest producer failure from successful depeg and dataset refreshes", async () => {
    const p = fixture();
    const result = await run(p, {
      digests: () => Promise.resolve({ status: 7, aborted: false, output: "digest failed\n" }),
      depegEvents: ({ outputPath }) => { writeJson(outputPath!, [{ id: "new" }]); return ok("depeg ok\n"); },
      publicDatasets: () => ok("datasets ok\n"),
      rollbackPublicDatasets: vi.fn(() => ok()),
    }, { env: { GITHUB_STEP_SUMMARY: p.summaryPath, NODE_ENV: "test" } });
    expect([result.digests.ok, result.depegEvents.ok, result.publicDatasets.ok]).toEqual([false, true, true]);
    expect(readJson(join(p.repoRoot, "data/digests.json"))).toHaveLength(2);
    expect(readJson(join(p.repoRoot, "data/depeg-events/index.json"))).toEqual([{ id: "new" }]);
    expect(readFileSync(p.summaryPath, "utf8")).toContain("- Digest refresh: false (2 entries)");
  });

  it("rejects a successful digest refresh when its row count shrinks", async () => {
    const p = fixture();
    const result = await run(p, {
      digests: ({ outputPath }) => { writeJson(outputPath!, [{ id: 1 }]); return ok(); },
      depegEvents: () => ok(), publicDatasets: () => ok(),
    });
    expect(result.digests).toMatchObject({ ok: false, refreshedCount: 1, shrinkRejected: true });
    expect(readJson(join(p.repoRoot, "data/digests.json"))).toHaveLength(2);
  });

  it("retains every committed depeg shard when pagination fails its integrity ceiling", async () => {
    const p = fixture(), shardPath = join(p.repoRoot, "data/depeg-events/2025.json"), indexPath = join(p.repoRoot, "data/depeg-events/index.json");
    writeJson(shardPath, [{ id: "historical" }]);
    const origIdx = readFileSync(indexPath, "utf8"), origShard = readFileSync(shardPath, "utf8");
    const result = await run(p, {
      digests: () => ok(),
      depegEvents: async () => { throw new SnapshotIntegrityError("Depeg pagination reached its safety ceiling with an outstanding cursor"); },
      publicDatasets: () => { expect(readFileSync(indexPath, "utf8")).toBe(origIdx); expect(readFileSync(shardPath, "utf8")).toBe(origShard); return ok(); },
    });
    expect(result.depegEvents.ok).toBe(false);
    expect(readFileSync(indexPath, "utf8")).toBe(origIdx);
    expect(readFileSync(shardPath, "utf8")).toBe(origShard);
    expect(readFileSync(join(p.refreshDir, "depeg.log"), "utf8")).toContain("using committed depeg snapshot");
  });

  it("rolls public datasets back without undoing successful snapshot refreshes", async () => {
    const p = fixture(), datasetPath = join(p.repoRoot, "public/datasets/latest.json");
    const rollback = vi.fn(() => { writeFileSync(datasetPath, "committed\n"); return ok("rolled back\n"); });
    const result = await run(p, {
      digests: ({ outputPath }) => { writeJson(outputPath!, [{ id: 1 }, { id: 2 }, { id: 3 }]); return ok(); },
      depegEvents: ({ outputPath }) => { writeJson(outputPath!, [{ id: "new" }]); return ok(); },
      publicDatasets: () => { writeFileSync(datasetPath, "partial\n"); return Promise.resolve({ status: 1, aborted: false, output: "dataset failed\n" }); },
      rollbackPublicDatasets: rollback,
    });
    expect(rollback).toHaveBeenCalledOnce();
    expect(result.publicDatasets).toMatchObject({ ok: false, rolledBack: true });
    expect(readFileSync(datasetPath, "utf8")).toBe("committed\n");
    expect(readJson(join(p.repoRoot, "data/digests.json"))).toHaveLength(3);
    expect(readJson(join(p.repoRoot, "data/depeg-events/index.json"))).toEqual([{ id: "new" }]);
  });

  it.each(["dated files", "aliases", "current module"] as const)("restores the complete pre-refresh bundle after failure following %s", async (boundary) => {
    const p = fixture(), topicDir = join(p.repoRoot, "public/datasets/top-stablecoins");
    mkdirSync(topicDir);
    const oldFiles = ["2026-07-01.json", "2026-10-18.csv", "2026-10-18.json", "2026-10-18.ndjson"];
    for (const name of oldFiles) writeFileSync(join(topicDir, name), `original ${name}\n`);
    const redirectsPath = join(p.repoRoot, "public/_redirects"), currentPath = join(p.repoRoot, "src/lib/datasets/public-dataset-current.ts");
    const prevRedirects = readFileSync(redirectsPath), prevCurrent = readFileSync(currentPath);
    const result = await run(p, {
      digests: ({ outputPath }) => { writeJson(outputPath!, [{ id: 1 }, { id: 2 }, { id: 3 }]); return ok(); },
      depegEvents: ({ outputPath }) => { writeJson(outputPath!, [{ id: "new" }]); return ok(); },
      publicDatasets: async () => {
        for (const ext of ["csv", "json", "ndjson"]) {
          writeFileSync(join(topicDir, `2026-10-19.${ext}`), `new ${ext}\n`);
          writeFileSync(join(topicDir, `2026-10-18.${ext}`), "overwritten\n");
        }
        rmSync(join(topicDir, "2026-07-01.json"));
        writeFileSync(join(p.repoRoot, "public/datasets/latest.json"), "partial\n");
        if (boundary === "dated files") throw new Error("dated write fault");
        writeFileSync(redirectsPath, prevRedirects.toString().replaceAll("2026-10-18", "2026-10-19"));
        if (boundary === "aliases") throw new Error("alias write fault");
        writeFileSync(currentPath, prevCurrent.toString().replaceAll("2026-10-18", "2026-10-19"));
        throw new Error("current module write fault");
      },
    });
    expect(result.publicDatasets).toMatchObject({ ok: false, rolledBack: true });
    expect(shouldFailReleaseRefresh(result)).toBe(false);
    expect(readdirSync(join(p.repoRoot, "public/datasets")).sort()).toEqual(["latest.json", "top-stablecoins"]);
    expect(readdirSync(topicDir).sort()).toEqual(oldFiles);
    for (const name of oldFiles) expect(readFileSync(join(topicDir, name), "utf8")).toBe(`original ${name}\n`);
    expect(readFileSync(join(p.repoRoot, "public/datasets/latest.json"), "utf8")).toBe("committed\n");
    expect(readFileSync(redirectsPath)).toEqual(prevRedirects);
    expect(readFileSync(currentPath)).toEqual(prevCurrent);
    expect(readJson(join(p.repoRoot, "data/digests.json"))).toHaveLength(3);
    expect(readJson(join(p.repoRoot, "data/depeg-events/index.json"))).toEqual([{ id: "new" }]);
  });

  it("removes newly created bundle targets when the pre-refresh workspace had none", async () => {
    const p = fixture(), targets = ["public/datasets", "public/_redirects", "src/lib/datasets/public-dataset-current.ts"];
    for (const t of targets) rmSync(join(p.repoRoot, t), { recursive: true, force: true });
    const result = await run(p, {
      digests: () => ok(), depegEvents: () => ok(),
      publicDatasets: async () => {
        mkdirSync(join(p.repoRoot, "public/datasets"));
        writeFileSync(join(p.repoRoot, "public/datasets/new.json"), "partial\n");
        writeFileSync(join(p.repoRoot, "public/_redirects"), "/new /missing 200\n");
        writeFileSync(join(p.repoRoot, "src/lib/datasets/public-dataset-current.ts"), "partial\n");
        return { status: 1, aborted: false };
      },
    });
    expect(result.publicDatasets).toMatchObject({ ok: false, rolledBack: true });
    for (const t of targets) expect(existsSync(join(p.repoRoot, t))).toBe(false);
  });

  it.each(["digests", "depegEvents"] as const)("isolates a rejected %s promise and persists the result", async (failed) => {
    const p = fixture(), digestPath = join(p.repoRoot, "data/digests.json"), depegPath = join(p.repoRoot, "data/depeg-events/index.json");
    const failedPath = failed === "digests" ? digestPath : depegPath, original = readFileSync(failedPath);
    const datasetPath = join(p.repoRoot, "public/datasets/latest.json"), resultPath = join(p.repoRoot, "custom-result.json");
    const result = await run(p, {
      digests: async ({ outputPath }) => { writeJson(outputPath!, [{ id: 3 }, { id: 4 }]); if (failed === "digests") throw new Error("producer sentinel"); return ok(); },
      depegEvents: async ({ outputPath }) => { writeJson(outputPath!, [{ id: "new" }]); if (failed === "depegEvents") throw new Error("producer sentinel"); return ok(); },
      publicDatasets: () => { writeFileSync(datasetPath, "refreshed\n"); return ok(); },
    }, { resultPath });
    expect(result[failed].ok).toBe(false);
    expect(result[failed === "digests" ? "depegEvents" : "digests"].ok).toBe(true);
    expect(readFileSync(failedPath)).toEqual(original);
    expect(readJson(failed === "digests" ? depegPath : digestPath)).toEqual(failed === "digests" ? [{ id: "new" }] : [{ id: 3 }, { id: 4 }]);
    expect(result.publicDatasets).toMatchObject({ ok: true, rolledBack: false });
    expect(readFileSync(datasetPath, "utf8")).toBe("refreshed\n");
    expect(result.resultPath).toBe(resultPath);
    expect(readJson(resultPath)).toEqual(result);
    expect(readFileSync(join(p.refreshDir, failed === "digests" ? "digest.log" : "depeg.log"), "utf8")).toContain("producer sentinel");
  });

  it("reports a failed rollback without claiming the partial dataset was restored", async () => {
    const p = fixture(), datasetPath = join(p.repoRoot, "public/datasets/latest.json");
    const result = await run(p, {
      digests: () => ok(), depegEvents: () => ok(),
      publicDatasets: () => { writeFileSync(datasetPath, "partial\n"); return Promise.resolve({ status: 1, aborted: false }); },
      rollbackPublicDatasets: () => Promise.resolve({ status: 2, aborted: false, output: "rollback sentinel\n" }),
    });
    expect(result.publicDatasets).toMatchObject({ ok: false, rolledBack: false });
    expect(shouldFailReleaseRefresh(result)).toBe(true);
    expect(readFileSync(datasetPath, "utf8")).toBe("partial\n");
    expect(readJson(result.resultPath)).toEqual(result);
    expect(readFileSync(join(p.refreshDir, "datasets.log"), "utf8")).toContain("rollback sentinel");
  });

  it("still blocks release when all producers fail even after a complete dataset rollback", async () => {
    const failed = async () => ({ status: 1, aborted: false });
    const result = await run(fixture(), { digests: failed, depegEvents: failed, publicDatasets: failed });
    expect([result.digests.ok, result.depegEvents.ok]).toEqual([false, false]);
    expect(result.publicDatasets).toMatchObject({ ok: false, rolledBack: true });
    expect(shouldFailReleaseRefresh(result)).toBe(true);
  });

  it("refreshes both snapshots concurrently and defers public datasets until they land", async () => {
    const p = fixture(), datasetPath = join(p.repoRoot, "public/datasets/latest.json"), bothStarted = concurrencyBarrier(2), order: string[] = [];
    const result = await run(p, {
      digests: async ({ outputPath }) => { order.push("digests:start"); await bothStarted(); writeJson(outputPath!, [{ id: 1 }, { id: 2 }, { id: 3 }]); order.push("digests:settled"); return ok(); },
      depegEvents: async ({ outputPath }) => { order.push("depeg:start"); await bothStarted(); writeJson(outputPath!, [{ id: "new" }]); order.push("depeg:settled"); return ok(); },
      publicDatasets: () => {
        order.push("datasets:start");
        writeJson(datasetPath, { depegEvents: readJson(join(p.repoRoot, "data/depeg-events/index.json")), digests: readJson(join(p.repoRoot, "data/digests.json")) });
        return ok();
      },
    });
    expect([...order.slice(0, 2)].sort()).toEqual(["depeg:start", "digests:start"]);
    expect(order).toHaveLength(5);
    expect(order[4]).toBe("datasets:start");
    expect(readJson(datasetPath)).toEqual({ depegEvents: [{ id: "new" }], digests: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    expect(result.digests).toMatchObject({ ok: true, refreshedCount: 3, durationMs: expect.any(Number) });
    expect(result.depegEvents).toMatchObject({ ok: true, durationMs: expect.any(Number) });
    expect(result.publicDatasets).toMatchObject({ ok: true, rolledBack: false, durationMs: expect.any(Number) });
  });
});
