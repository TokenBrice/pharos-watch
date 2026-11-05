import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runGeneratedArtifacts } from "../maintenance/run-generated-artifacts";
import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mts";

describe("contracts workspace generated-artifact inputs", () => {
  it.each(["shared/contracts/api-meta.ts", "scripts/lib/public-api-response-schemas.ts"])(
    "invalidates OpenAPI and its dependent API reference for %s",
    (file) => {
      expect(selectChangedGeneratedArtifactIds([file])).toEqual(expect.arrayContaining(["openapi", "api-reference"]));
    },
  );

  it("retains schema-input selection for the catalog after the package move", () => {
    for (const path of ["shared/contracts/request-source.ts", "shared/types/core.ts"]) {
      expect(selectChangedGeneratedArtifactIds([path])).toContain("stablecoin-catalog");
    }
  });
});

const run = (argv: string[], runCommandImpl: (command: string) => Promise<number>, log = vi.fn()) =>
  runGeneratedArtifacts({ argv, runCommandImpl, log, env: { NODE_ENV: "test" } });

describe("generated-artifact runner lifecycle selection", () => {
  const refreshArgv = ["--build-lifecycle=post-refresh"];
  const upstreamScript = "generate-stablecoin-per-coin-asset";
  const ids = ["stablecoin-catalog", "depeg-event-search-data", "report-card-registry-fingerprint", "stablecoin-detail-snapshots", "llms-txt"];
  const downstream = ids.slice(2).map((id) => `${id.startsWith("stablecoin-") ? "build" : "generate"}-${id}`);
  const rejectsDownstream = (calls: [string, ...unknown[]][]) => {
    for (const script of downstream) expect(calls.some(([cmd]) => cmd.includes(script))).toBe(false);
  };
  it.each(["runbook-index,sitemap-dates"])("rejects CLI request %s without filesystem writes", (ids) => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-uncheckable-"));
    try {
      const result = spawnSync(process.execPath, [
        "--import", resolve("node_modules/tsx/dist/loader.mjs"),
        resolve("scripts/maintenance/run-generated-artifacts.ts"),
        "--check", `--only=${ids}`,
      ], { cwd, encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("bootstrap:generated:history");
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(["sitemap-dates", "runbook-index,sitemap-dates"])("rejects explicit uncheckable selection %s before any child executes", async (ids) => {
    const child = vi.fn(async () => 0);
    await expect(run(["--check", `--only=${ids}`], child))
      .rejects.toThrow(/sitemap-dates.*git-history-derived.*bootstrap:generated:history/);
    expect(child).not.toHaveBeenCalled();
  });

  it("reports a legitimate empty intersection without running children", async () => {
    const log = vi.fn();
    const child = vi.fn(async () => 0);
    const result = await run(["--check", "--only=runbook-index", "--phase=2"], child, log);
    expect(result).toMatchObject({ status: 0, results: [] });
    expect(child).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no checks executed"));
  });

  it("waits for upstream completion before starting dependent phases", async () => {
    const upstream = Promise.withResolvers<number>();
    const entered = Promise.withResolvers<void>();
    const child = vi.fn(async (command: string) => {
      if (command.includes(upstreamScript)) {
        entered.resolve();
        return upstream.promise;
      }
      return 0;
    });
    const pending = run(refreshArgv, child);
    await entered.promise;
    rejectsDownstream(child.mock.calls);
    upstream.resolve(0);
    const result = await pending;
    expect(result.status).toBe(0);
    expect(result.results.map(({ id }) => id)).toEqual(ids);
  });

  it.each([
    ["stops later phases after an upstream failure", false],
    ["retains the failure and propagates transitive taint without tainting independent artifacts", true],
  ] as const)("%s", async (_name, continued) => {
    const child = vi.fn(async (command: string) => command.includes(upstreamScript) ? 7 : 0);
    const result = await run([...refreshArgv, ...(continued ? ["--continue-on-error"] : [])], child);
    expect(result.status).toBe(7);
    if (!continued) rejectsDownstream(child.mock.calls);
    else {
      expect(result.results.map(({ id, statusLabel, taintedBy }) => [id, statusLabel, taintedBy]))
        .toEqual(ids.map((id, i) => [id, i === 0 ? "failed" : i === 1 ? "passed" : "tainted", i > 1 ? [ids[0]] : []]));
      expect(result.failures.map(({ status }) => status)).toEqual([7]);
    }
  });
});

describe("evaluation manifest scheduling", () => {
  const only = "--only=safety-score-v9-evaluation-build";
  it.each([["", 0, 7], ["--check", 0, 7], ["--dry-run", 0, 0], ["--check", 1, 6]] as const)(
    "forwards mode %s with prerequisite status %s", async (mode, failure, count) => {
      const child = vi.fn(async (cmd: string) => {
        if (mode === "--check") expect(cmd).toMatch(/ --check$/);
        return cmd.includes("lane-emitter-descriptors") ? failure : 0;
      });
      expect((await run([only, ...(mode ? [mode] : [])], child)).status).toBe(failure);
      expect(child).toHaveBeenCalledTimes(count);
      if (failure) expect(child.mock.calls.some(([cmd]) => cmd.includes("evaluation-build-manifest"))).toBe(false);
    },
  );
});
