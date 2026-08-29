import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildDependencyCoverageAudit,
  renderDependencyCoverageAuditMarkdown,
} from "../maintenance/generate-dependency-coverage-audit";
import {
  buildReserveCoverageAudit,
  renderReserveCoverageAuditMarkdown,
} from "../maintenance/generate-reserve-coverage-audit";
import {
  buildL2BeatSnapshotCoverageAudit,
  renderL2BeatSnapshotCoverageAuditMarkdown,
} from "../maintenance/generate-l2beat-snapshot-coverage-audit";

const generatedAt = "2026-08-28T00:00:00.000Z";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("coverage audit byte goldens", () => {
  it.each([
    {
      name: "dependency",
      build: () => buildDependencyCoverageAudit({ generatedAt }),
      markdown: renderDependencyCoverageAuditMarkdown,
      markdownSha: "c47d43372718d5aafd410229402e9a761447da9fcf4922046bb93228f870565d",
      jsonSha: "1d1f2c6ac1602ebf628ee749b073d81e0909e20764ccdffa80787c47cb935aca",
    },
    {
      name: "reserve",
      build: () => buildReserveCoverageAudit({ generatedAt }),
      markdown: renderReserveCoverageAuditMarkdown,
      markdownSha: "9d56e77437499105628be7c82909aecc8f25f22114c39e853b6785dae1b55e5d",
      jsonSha: "060da14dc7cff7cf43603b48c6b7f06b00497f4da53f3237ee6fb984106cdc07",
    },
    {
      name: "l2beat",
      build: () => buildL2BeatSnapshotCoverageAudit({ generatedAt }),
      markdown: renderL2BeatSnapshotCoverageAuditMarkdown,
      markdownSha: "cf653fdcc98715a346ad00445df431ba9893863467983e65f10f0715e466440b",
      jsonSha: "07e5e4ec6a03b3c664cdb5be25083780410c507f1c3a132b4073b1cd562c99c8",
    },
  ])("preserves $name Markdown and JSON bytes", ({ build, markdown, markdownSha, jsonSha }) => {
    const audit = build();
    expect(sha256(markdown(audit as never))).toBe(markdownSha);
    expect(sha256(`${JSON.stringify(audit, null, 2)}\n`)).toBe(jsonSha);
  });
});
