import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { normalize, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildReportCardsFixedInputCacheEntry } from "../../src/test-helpers/report-cards-fixed-input";
import { createReplayFixedInput } from "./safety-score-v9-replay.test-support";
import { v9TestClockSec } from "../../src/test-helpers/v9-fixed-input";

type Step = { id?: string; run?: string };
const root = resolve(import.meta.dirname, "../../..");
const workflow = parse(readFileSync(resolve(root, ".github/workflows/curation-expiry-sweep.yml"), "utf8"));
const steps: Step[] = workflow.jobs.sweep.steps;

function stepRun(id: string): string {
  const run = steps.find((step) => step.id === id)?.run;
  if (!run) throw new Error(`Missing curation workflow run step: ${id}`);
  return run;
}

function scriptCommands(run: string): string[] {
  return run.replace(/\\\n\s*/g, " ").split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:npm run |node |tsx |npx (?:--no-install )?tsx )/.test(line))
    .map((line) => line.split("2>&1")[0]!.trim());
}

describe("curation sweep executable workflow contract", () => {
  it("runs capture and every queue entrypoint with the workflow's actual npm/module invocation", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pharos-curation-cli-"));
    // Freeze the clock from reviewed fixture authority, not wall time. Deriving
    // it once also keeps unrelated later curation dates from aging this test.
    const clockSec = v9TestClockSec();
    try {
      const input = createReplayFixedInput(clockSec);
      const entry = await buildReportCardsFixedInputCacheEntry(input);
      writeFileSync(resolve(dir, "capture.raw.json"), JSON.stringify([{ success: true, results: [{ value: entry.value }] }]));
      const commands = [...scriptCommands(stepRun("capture")), ...scriptCommands(stepRun("generate"))];
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        const localCommand = command.replaceAll("agents/sweep/", `${dir}/`);
        const result = spawnSync("bash", ["-euo", "pipefail", "-c", localCommand], {
          cwd: root,
          env: { ...process.env, CLOCK_SEC: String(clockSec) },
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        expect(result.error, command).toBeUndefined();
        expect(result.status, `${command}\n${result.stdout}\n${result.stderr}`).toBe(0);
      }
      const replay = JSON.parse(readFileSync(resolve(dir, "replay.json"), "utf8"));
      const registry = JSON.parse(readFileSync(resolve(dir, "missing-data-registry.json"), "utf8"));
      expect(replay.pipeline.fixedInput.clockSec).toBe(clockSec);
      expect(replay.pipeline.compiledFacts.asOfSec).toBe(clockSec);
      expect(registry.snapshot.asOfSec).toBe(clockSec);
      expect(registry.snapshot.factSetDigest).toBe(replay.pipeline.compiledFacts.v9FactSetDigest);
      expect(registry.summary.stablecoinCount).toBe(1);
      expect(registry.stablecoins[0].assetId).toBe("usdc-circle");
      expect(readFileSync(resolve(dir, "worklist.md"), "utf8")).toContain("usdc-circle");
      expect(readFileSync(resolve(dir, "expiry-queue.md"), "utf8").length).toBeGreaterThan(0);
      expect(readFileSync(resolve(dir, "live-withheld.md"), "utf8").length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

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
