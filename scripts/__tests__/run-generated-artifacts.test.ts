import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildGeneratedArtifactExecutionPhases,
  parseGeneratedArtifactsArgs,
  runGeneratedArtifacts,
} from "../maintenance/run-generated-artifacts";
import { selectCheckableArtifactIds, selectGeneratedArtifacts } from "../lib/automation-registry.mjs";
import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mts";
import { buildPrStaticCheckPlan } from "../maintenance/run-pr-static-checks.ts";

describe("generated-artifact runner lifecycle selection", () => {
  it.each(["sitemap-dates", "agents-doc,sitemap-dates"])("rejects CLI request %s without filesystem writes", (ids) => {
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

  it.each(["sitemap-dates", "agents-doc,sitemap-dates"])("rejects explicit uncheckable selection %s before any child executes", async (ids) => {
    const runCommandImpl = vi.fn(async () => 0);
    await expect(runGeneratedArtifacts({ argv: ["--check", `--only=${ids}`], runCommandImpl }))
      .rejects.toThrow(/sitemap-dates.*git-history-derived.*bootstrap:generated:history/);
    expect(runCommandImpl).not.toHaveBeenCalled();
  });

  it.each(["src/app/page.tsx", "shared/lib/public-docs.ts"])("keeps routine PR artifact plans checkable for %s", (file) => {
    const expected = selectCheckableArtifactIds(selectChangedGeneratedArtifactIds([file]));
    const step = buildPrStaticCheckPlan([file]).commands.find((command) => command.name === "check:generated-artifacts");
    expect(step?.args).toEqual(expected.length ? [`--only=${expected.join(",")}`] : undefined);
    const guardsStep = buildPrStaticCheckPlan([file], { group: "guards" }).commands
      .find((command) => command.name === "check:generated-artifacts");
    expect(guardsStep).toEqual(step);
    expect(buildPrStaticCheckPlan([file], { group: "compile" }).commands
      .some((command) => command.name === "check:generated-artifacts")).toBe(false);
    expect(selectGeneratedArtifacts({ check: true, only: expected }).map((artifact) => artifact.id))
      .not.toContain("sitemap-dates");
    expect(expected).not.toContain("docs-metadata");
    // llms-txt remains checkable in the current registry; do not suppress it.
    if (file === "shared/lib/public-docs.ts") expect(expected).toContain("llms-txt");
  });

  it("reports a legitimate empty intersection without running children", async () => {
    const log = vi.fn();
    const runCommandImpl = vi.fn(async () => 0);
    const result = await runGeneratedArtifacts({
      argv: ["--check", "--only=agents-doc", "--phase=2"], log, runCommandImpl,
    });
    expect(result).toMatchObject({ status: 0, results: [] });
    expect(runCommandImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no checks executed"));
  });

  it.each([
    ["--build-lifecycle=compile-input,post-refresh", "--build-lifecycle", "compile-input"],
    ["--build-lifecycle=compile-input", "--build-lifecycle=post-refresh", "--build-lifecycle=compile-input"],
  ])("parses and de-duplicates lifecycle filters for %j", (...argv) => {
    expect(parseGeneratedArtifactsArgs(argv).buildLifecycles).toEqual(["compile-input", "post-refresh"]);
  });

  it("includes declared dependencies for a post-refresh selection", () => {
    expect(
      buildGeneratedArtifactExecutionPhases({ buildLifecycles: ["post-refresh"] }).map(({ phase, units }) => ({
        phase,
        ids: units.map((unit) => unit.id),
      })),
    ).toEqual([
      { phase: 0, ids: ["stablecoin-catalog", "depeg-event-search-data"] },
      { phase: 1, ids: ["report-card-registry-fingerprint", "stablecoin-detail-snapshots"] },
      { phase: 2, ids: ["llms-txt"] },
    ]);
  });

  it("selects only the catalog dependency when narrowing post-refresh to snapshots", () => {
    expect(buildGeneratedArtifactExecutionPhases({
      buildLifecycles: ["post-refresh"], only: ["stablecoin-detail-snapshots"],
    }).map(({ phase, units }) => ({
      phase, ids: units.map(({ id }) => id),
    }))).toEqual([
      { phase: 0, ids: ["stablecoin-catalog"] },
      { phase: 1, ids: ["stablecoin-detail-snapshots"] },
    ]);
  });

  it("rejects unknown lifecycle names", () => {
    expect(() => buildGeneratedArtifactExecutionPhases({ buildLifecycles: ["release-ish"] })).toThrow(
      /Unknown generated artifact build lifecycle/,
    );
  });

  it("prints a lifecycle-filtered dry-run plan without executing generators", async () => {
    const log: string[] = [];
    const runCommandImpl = vi.fn(async () => 0);
    const result = await runGeneratedArtifacts({
      argv: ["--build-lifecycle=post-refresh", "--dry-run"],
      log: (message) => log.push(message),
      runCommandImpl,
    });

    expect(result.status).toBe(0);
    expect(runCommandImpl).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
    expect(log.join("\n")).toContain("generate-depeg-event-search-data.ts");
    expect(log.join("\n")).toContain("generate-llms-txt.ts");
    expect(log.join("\n")).toContain("build-stablecoin-detail-snapshots.ts");
    expect(log.join("\n")).not.toContain("generate-sitemap-dates.ts");
    expect(log.join("\n")).not.toContain("generate-docs-metadata.ts");
    expect(log.join("\n")).not.toContain("build-og-editorial.mjs");
  });

  it("waits for upstream completion before starting dependent phases", async () => {
    let release!: (status: number) => void;
    let started!: () => void;
    const upstream = new Promise<number>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const commands: string[] = [];
    const pending = runGeneratedArtifacts({
      argv: ["--build-lifecycle=post-refresh"], env: { NODE_ENV: "test" }, log: () => {},
      runCommandImpl: async (command) => {
        commands.push(command);
        if (command.includes("generate-stablecoin-per-coin-asset")) {
          started();
          return upstream;
        }
        return 0;
      },
    });
    await entered;
    expect(commands.some((command) => command.includes("generate-report-card-registry-fingerprint"))).toBe(false);
    expect(commands.some((command) => command.includes("build-stablecoin-detail-snapshots"))).toBe(false);
    expect(commands.some((command) => command.includes("generate-llms-txt"))).toBe(false);
    release(0);
    const result = await pending;
    expect(result.status).toBe(0);
    expect(result.results.map(({ id }) => id)).toEqual([
      "stablecoin-catalog", "depeg-event-search-data", "report-card-registry-fingerprint",
      "stablecoin-detail-snapshots", "llms-txt",
    ]);
  });

  it("stops later phases after an upstream failure", async () => {
    const commands: string[] = [];
    const result = await runGeneratedArtifacts({
      argv: ["--build-lifecycle=post-refresh"], env: { NODE_ENV: "test" }, log: () => {},
      runCommandImpl: async (command) => {
        commands.push(command);
        return command.includes("generate-stablecoin-per-coin-asset") ? 7 : 0;
      },
    });
    expect(result.status).toBe(7);
    expect(commands.some((command) => command.includes("generate-report-card-registry-fingerprint"))).toBe(false);
    expect(commands.some((command) => command.includes("build-stablecoin-detail-snapshots"))).toBe(false);
    expect(commands.some((command) => command.includes("generate-llms-txt"))).toBe(false);
  });

  it("retains the failure and propagates transitive taint without tainting independent artifacts", async () => {
    const result = await runGeneratedArtifacts({
      argv: ["--build-lifecycle=post-refresh", "--continue-on-error"], env: { NODE_ENV: "test" }, log: () => {},
      runCommandImpl: async (command) => command.includes("generate-stablecoin-per-coin-asset") ? 7 : 0,
    });
    expect(result.status).toBe(7);
    expect(result.results.map(({ id, statusLabel, taintedBy }) => ({ id, statusLabel, taintedBy }))).toEqual([
      { id: "stablecoin-catalog", statusLabel: "failed", taintedBy: [] },
      { id: "depeg-event-search-data", statusLabel: "passed", taintedBy: [] },
      { id: "report-card-registry-fingerprint", statusLabel: "tainted", taintedBy: ["stablecoin-catalog"] },
      { id: "stablecoin-detail-snapshots", statusLabel: "tainted", taintedBy: ["stablecoin-catalog"] },
      { id: "llms-txt", statusLabel: "tainted", taintedBy: ["stablecoin-catalog"] },
    ]);
    expect(result.failures.map(({ status }) => status)).toEqual([7]);
  });
});
