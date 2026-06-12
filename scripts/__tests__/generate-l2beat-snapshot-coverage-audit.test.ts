import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildL2BeatSnapshotCoverageAudit,
  compareSnapshotToObserved,
  parseArgs,
  parseL2BeatSummaryProjects,
  renderL2BeatSnapshotCoverageAuditMarkdown,
  runCli,
} from "../maintenance/generate-l2beat-snapshot-coverage-audit";

const riskNames = [
  "Sequencer Failure",
  "State Validation",
  "Data Availability",
  "Exit Window",
  "Proposer Failure",
];

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: "base",
    name: "Base Chain",
    slug: "base",
    type: "layer2",
    hostChain: "Ethereum",
    category: "Optimistic Rollup",
    stage: "Stage 1",
    isUnderReview: false,
    risks: riskNames.map((name) => ({
      name,
      value: name === "Exit Window" ? "None" : "Self sequence",
      sentiment: name === "Exit Window" ? "bad" : "good",
    })),
    ...overrides,
  };
}

describe("generate-l2beat-snapshot-coverage-audit", () => {
  it("parses CLI options", () => {
    expect(parseArgs([
      "--input",
      "agents/l2beat.json",
      "--json",
      "--check",
      "--report",
      "agents/report.json",
      "--generated-at",
      "2026-06-12T00:00:00.000Z",
    ])).toMatchObject({
      inputPath: "agents/l2beat.json",
      format: "json",
      check: true,
      reportPath: "agents/report.json",
      generatedAt: "2026-06-12T00:00:00.000Z",
    });
    expect(() => parseArgs(["--input", "fixture.json", "--live"])).toThrow("Choose only one of --input or --live.");
  });

  it("detects drift for consumed L2BEAT fields", () => {
    const observed = parseL2BeatSummaryProjects({
      projects: {
        base: project({
          stage: "Stage 0",
          risks: riskNames.map((name) => ({
            name,
            value: name === "Exit Window" ? "None" : "Self sequence",
            sentiment: name === "State Validation" ? "warning" : name === "Exit Window" ? "bad" : "good",
          })),
        }),
      },
    });

    const drift = compareSnapshotToObserved(observed);

    expect(drift.driftRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: "base", field: "stage", current: "Stage 1", observed: "Stage 0" }),
      expect.objectContaining({
        projectId: "base",
        field: "State Validation sentiment",
        current: "good",
        observed: "warning",
      }),
      expect.objectContaining({ projectId: "arbitrum", kind: "missing-live-project" }),
    ]));
  });

  it("renders matched chains and alias integrity", () => {
    const audit = buildL2BeatSnapshotCoverageAudit({ generatedAt: "2026-06-12T00:00:00.000Z" });
    const markdown = renderL2BeatSnapshotCoverageAuditMarkdown(audit);

    expect(markdown).toContain("# L2BEAT Snapshot Coverage Audit");
    expect(markdown).toContain("- Matched chains: 39");
    expect(markdown).toContain("Base (base)");
    expect(markdown).toContain("## Alias Integrity Issues");
    expect(markdown).toContain("_None._");
  });

  it("returns non-zero in check mode when fixture drift is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pharos-l2beat-"));
    const inputPath = join(dir, "summary.json");
    writeFileSync(inputPath, JSON.stringify({ projects: { base: project({ stage: "Stage 0" }) } }), "utf8");
    const stdout = { write: vi.fn(() => true) };

    await expect(runCli(["--input", inputPath, "--check"], stdout)).resolves.toBe(1);
    expect(stdout.write).toHaveBeenCalled();
  });
});
