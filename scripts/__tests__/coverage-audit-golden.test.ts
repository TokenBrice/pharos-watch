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
      markdownSha: "ae44f8f08fb6fe2d5573d4f55c7f1489e18b069346dd75a7b342b9e0c464fe7e",
      jsonSha: "70e156f9e9e286c23f7e85987ccbfd39bf6b993c364a71e98e58928c01efc3f3",
    },
    {
      name: "reserve",
      build: () => buildReserveCoverageAudit({ generatedAt }),
      markdown: renderReserveCoverageAuditMarkdown,
      markdownSha: "a062771b01af321a70251f4fea5efc74a863eae7bf25c95ede2566363ad6c17b",
      jsonSha: "93069054a7d3c2cb439e454e42d6844d8709561a9bb44195bb234d7b8090c6c5",
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
