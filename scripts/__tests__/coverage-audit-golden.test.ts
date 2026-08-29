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
      markdownSha: "141b03a385cb3866cf42fdf31a5bbb2a8d53e7783b7fe92169d42d51f9e5b3b9",
      jsonSha: "ddcc93b5c1fb9062370acd5baf04f5dcadeeb6d3fcc01535cc94326f3baa8e6d",
    },
    {
      name: "reserve",
      build: () => buildReserveCoverageAudit({ generatedAt }),
      markdown: renderReserveCoverageAuditMarkdown,
      markdownSha: "8dd9d612358dc95cc7cf96cb61e731b9ffe265f2ccf9f80a8f29cfe76fd185d6",
      jsonSha: "63ec7d39ea0ee483d4442cb3cf4ca44891b605b382cb76a034009d9c0d03291c",
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
