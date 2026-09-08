import { describe, expect, it, vi } from "vitest";
import {
  buildGeneratedArtifactExecutionPhases,
  parseGeneratedArtifactsArgs,
  runGeneratedArtifacts,
} from "../maintenance/run-generated-artifacts";

describe("generated-artifact runner lifecycle selection", () => {
  it("parses and de-duplicates lifecycle filters", () => {
    expect(
      parseGeneratedArtifactsArgs([
        "--build-lifecycle=compile-input,post-refresh",
        "--build-lifecycle",
        "compile-input",
      ]).buildLifecycles,
    ).toEqual(["compile-input", "post-refresh"]);
  });

  it("includes declared dependencies for a post-refresh selection", () => {
    expect(
      buildGeneratedArtifactExecutionPhases({ buildLifecycles: ["post-refresh"] }).map(({ phase, units }) => ({
        phase,
        ids: units.map((unit) => unit.id),
      })),
    ).toEqual([
      { phase: 0, ids: ["stablecoin-catalog", "depeg-event-search-data"] },
      { phase: 1, ids: ["report-card-registry-fingerprint"] },
      { phase: 2, ids: ["llms-txt"] },
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
    expect(commands.some((command) => command.includes("generate-llms-txt"))).toBe(false);
    release(0);
    const result = await pending;
    expect(result.status).toBe(0);
    expect(result.results.map(({ id }) => id)).toEqual([
      "stablecoin-catalog", "depeg-event-search-data", "report-card-registry-fingerprint", "llms-txt",
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
      { id: "llms-txt", statusLabel: "tainted", taintedBy: ["stablecoin-catalog"] },
    ]);
    expect(result.failures.map(({ status }) => status)).toEqual([7]);
  });
});
