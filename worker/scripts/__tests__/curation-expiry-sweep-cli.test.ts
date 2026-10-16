import { readFileSync } from "node:fs";

import { normalize, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { id?: string; run?: string };
const root = resolve(import.meta.dirname, "../../..");
const workflow = parse(readFileSync(resolve(root, ".github/workflows/curation-expiry-sweep.yml"), "utf8"));
const steps: Step[] = workflow.jobs.sweep.steps;

function stepRun(id: string): string {
  const run = steps.find((step) => step.id === id)?.run;
  if (!run) throw new Error(`Missing curation workflow run step: ${id}`);
  return run;
}

describe("curation sweep executable workflow contract", () => {
  it("keeps the generated summary and snapshot PR paths outside workflow permission scope", () => {
    const generation = stepRun("generate");
    const output = generation.match(/>\s*(\S*missing-data-registry-summary\.json)/)?.[1];
    expect(output).toBeDefined();
    const summaryPath = normalize(output!);
    expect(summaryPath.startsWith(".github/workflows/")).toBe(false);
    const publication = steps.filter((step) => step.id === "registry_diff" || step.run?.includes("--body \"$PR_BODY\""));
    expect(publication).toHaveLength(2);
    for (const step of publication) {
      const paths = step.run!.match(/\S*missing-data-registry-summary\.json/g) ?? [];
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) expect(normalize(path)).toBe(summaryPath);
    }
  });
});
