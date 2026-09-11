import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { L2BEAT_CHAIN_RISK_SNAPSHOT, L2BEAT_CHAIN_RISK_FIELD_LABELS } from "@shared/lib/chains/l2beat-risk";
import {
  buildL2BeatSnapshotCoverageAudit,
  compareSnapshotToObserved,
  parseArgs,
  parseL2BeatSummaryProjects,
  renderL2BeatSnapshotCoverageAuditMarkdown,
  runCli,
} from "../maintenance/generate-l2beat-snapshot-coverage-audit";

function observedBaseline() {
  return { projects: Object.fromEntries(Object.entries(L2BEAT_CHAIN_RISK_SNAPSHOT).map(([id, snapshot]) => [id, {
    ...snapshot,
    id,
    risks: Object.entries(snapshot.risks).map(([field, risk]) => ({
      name: L2BEAT_CHAIN_RISK_FIELD_LABELS[field as keyof typeof L2BEAT_CHAIN_RISK_FIELD_LABELS],
      ...risk,
    })),
  }])) };
}

describe("generate-l2beat-snapshot-coverage-audit", () => {
  it("parses CLI options", () => {
    expect(parseArgs([
      "--input", "agents/l2beat.json", "--json", "--check", "--report", "agents/report.json",
      "--generated-at", "2026-06-12T00:00:00.000Z",
    ])).toMatchObject({
      inputPath: "agents/l2beat.json", format: "json", check: true,
      reportPath: "agents/report.json", generatedAt: "2026-06-12T00:00:00.000Z",
    });
    expect(() => parseArgs(["--input", "fixture.json", "--live"])).toThrow("Choose only one of --input or --live.");
  });

  it.each(["changed", "missing"])("isolates a %s consumed risk from an exact baseline", (mutation) => {
    const payload = observedBaseline();
    expect(compareSnapshotToObserved(parseL2BeatSummaryProjects(payload))).toEqual({ driftRows: [], observedOnlyProjects: [] });
    const risk = payload.projects.base.risks[0];
    const current = risk.value;
    if (mutation === "changed") risk.value = "changed fixture risk";
    else payload.projects.base.risks.shift();
    expect(compareSnapshotToObserved(parseL2BeatSummaryProjects(payload))).toEqual({
      driftRows: [{ projectId: "base", kind: "risk-value-changed",
        field: mutation === "changed" ? `${risk.name} value` : risk.name,
        current: mutation === "changed" ? current : `${current} (${risk.sentiment})`,
        observed: mutation === "changed" ? "changed fixture risk" : "missing from observed L2BEAT summary",
      }],
      observedOnlyProjects: [],
    });
  });

  it("renders a controlled matched-chain count and alias integrity", () => {
    const audit = buildL2BeatSnapshotCoverageAudit({ generatedAt: "2026-06-12T00:00:00.000Z" });
    audit.coverage.summary.matchedChainCount = 2;
    audit.coverage.matchedChains = audit.coverage.matchedChains.slice(0, 2);
    const markdown = renderL2BeatSnapshotCoverageAuditMarkdown(audit);
    expect(markdown).toContain("# L2BEAT Snapshot Coverage Audit");
    expect(markdown).toContain("- Matched chains: 2");
    expect(markdown).toContain("## Alias Integrity Issues");
  });

  it("passes an exact baseline and observed-only addition, but fails consumed drift", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pharos-l2beat-"));
    try {
      const inputPath = join(dir, "summary.json");
      const payload = observedBaseline();
      const stdout = { write: vi.fn(() => true) };
      const run = () => {
        writeFileSync(inputPath, JSON.stringify(payload), "utf8");
        return runCli(["--input", inputPath, "--check"], stdout);
      };
      await expect(run()).resolves.toBe(0);
      payload.projects.extra = { ...payload.projects.base, id: "extra" };
      expect(compareSnapshotToObserved(parseL2BeatSummaryProjects(payload))).toEqual({ driftRows: [], observedOnlyProjects: ["extra"] });
      await expect(run()).resolves.toBe(0);
      payload.projects.base.risks[0].value = "changed fixture risk";
      await expect(run()).resolves.toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
