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
      markdownSha: "f91336960b8a9999b4d922bb0663e3112f1e931df66d79890ec54e3f0edf536e",
      jsonSha: "7a53091281e6bb59c442c1ea85a210ac20d9ddf6ee01278c2a7737dffb79572d",
    },
    {
      name: "reserve",
      build: () => buildReserveCoverageAudit({ generatedAt }),
      markdown: renderReserveCoverageAuditMarkdown,
      markdownSha: "ec67ceb05b0a7353bee851cf774b482b065dab3afd413eff243722e832390687",
      jsonSha: "a1c47bf8b176da3ca6bc0cafb7262bb389620509bf8001c2bc3fdfeec4684ed5",
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
