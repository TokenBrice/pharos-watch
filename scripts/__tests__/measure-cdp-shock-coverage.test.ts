import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replayEvidence } from "../maintenance/measure-cdp-shock-coverage";
import { buildMechanismCaptureSummary, summaryPathForCapture } from "../lib/mechanism-measurement/capture-summary";
import { createTempRepoTracker } from "./helpers/test-state";
import { remote } from "./measure-cdp-mechanism-metrics.test-support";
import { makeShockReplayFixture } from "./measure-cdp-shock-coverage.test-support";

const roots = createTempRepoTracker("pharos-shock-replay");
afterEach(() => { roots.cleanup(); vi.restoreAllMocks(); });

async function captureFixture() {
  const root = roots.makeRoot();
  const bodyPath = resolve(root, "shared/data/safety-score-v9/mechanism-measurements/lusd-liquity/2026-10-01-shock-coverage.json");
  const body = Buffer.from(JSON.stringify(await makeShockReplayFixture()));
  const summary = buildMechanismCaptureSummary(body, bodyPath, root);
  mkdirSync(dirname(bodyPath), { recursive: true });
  writeFileSync(summaryPathForCapture(bodyPath), JSON.stringify(summary));
  const cacheDir = resolve(root, "agents/.cache/measurements");
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = resolve(cacheDir, `${summary.sha256}.json`);
  return { root, bodyPath, body, summary, cachePath };
}

describe("shock coverage summary-backed replay", () => {
  it("byte-replays a raw-absent journal from hash-verified cache through the CLI", async () => {
    const fixture = await captureFixture();
    writeFileSync(fixture.cachePath, fixture.body);
    const stdout = execFileSync(process.execPath, [
      "--import", import.meta.resolve("tsx"),
      resolve("scripts/maintenance/measure-cdp-shock-coverage.ts"), "--replay", fixture.bodyPath,
    ], { cwd: fixture.root, env: { ...process.env, TSX_TSCONFIG_PATH: resolve("tsconfig.json") }, encoding: "utf8" });
    expect(stdout).toContain("byte-identical offline replay passed");
  });

  it("resolves pinned bodies while retaining exact replay and code-pin validation", async () => {
    const fixture = await captureFixture();
    const get = vi.fn(async (key: string) => key.startsWith("pinned/") ? gzipSync(fixture.body) : null);
    await expect(replayEvidence(fixture.bodyPath, { rootDir: fixture.root, r2Client: remote(get) })).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledWith(fixture.summary.r2Key.replace(/^captures\//, "pinned/"));
  });

  it("rejects missing, expired and corrupt bodies without treating summaries as replay", async () => {
    const fixture = await captureFixture();
    await expect(replayEvidence(resolve(fixture.root, "missing.json"), { rootDir: fixture.root })).rejects.toThrow("Missing shock coverage capture or summary");
    await expect(replayEvidence(fixture.bodyPath, { rootDir: fixture.root, r2Client: remote(async () => null) })).rejects.toThrow("expired: non-replayable");
    await expect(replayEvidence(fixture.bodyPath, { rootDir: fixture.root, r2Client: remote(async () => gzipSync(Buffer.from("corrupt"))) })).rejects.toThrow("integrity mismatch");
    writeFileSync(fixture.cachePath, "corrupt");
    await expect(replayEvidence(fixture.bodyPath, { rootDir: fixture.root })).rejects.toThrow("integrity mismatch");
  });
});
