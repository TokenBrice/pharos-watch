import { describe, expect, it } from "vitest";
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
    const result = await runGeneratedArtifacts({
      argv: ["--build-lifecycle=post-refresh", "--dry-run"],
      log: (message) => log.push(message),
    });

    expect(result.status).toBe(0);
    expect(log.join("\n")).toContain("generate-depeg-event-search-data.ts");
    expect(log.join("\n")).toContain("generate-llms-txt.ts");
    expect(log.join("\n")).not.toContain("build-og-editorial.mjs");
  });
});
