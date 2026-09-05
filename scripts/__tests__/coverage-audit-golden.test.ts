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
      markdownSha: "334b012df1ad64307aa54d75ff1f6a3467537e2f5e5fda6c45a089d31b88c8c8",
      jsonSha: "9f3ca67b9a7614f52c217541c1e48047875725d7e360ba6740b9a424c2fe4791",
    },
    {
      name: "reserve",
      build: () => buildReserveCoverageAudit({ generatedAt }),
      markdown: renderReserveCoverageAuditMarkdown,
      markdownSha: "acd6d91ad07b2dbaa3257c723a2b8926cd68f90a560cc7b1a13fe0f3c66fe7ce",
      jsonSha: "2e83f6608c55f43ac702e56253f1c54434ae4f59c71b37a9015bfc80dfdf88da",
    },
    {
      name: "l2beat",
      build: () => buildL2BeatSnapshotCoverageAudit({ generatedAt }),
      markdown: renderL2BeatSnapshotCoverageAuditMarkdown,
      markdownSha: "806a819a639fb9201e2b37db4aa280bcb7d81566a6dfa89e10034fb0c47b2ca9",
      jsonSha: "9b92e70def428ad9fdcaae77fae26ef9ff8a708d2963742c94f8c4205aa58da5",
    },
  ])("preserves $name Markdown and JSON bytes", ({ build, markdown, markdownSha, jsonSha }) => {
    const audit = build();
    expect(sha256(markdown(audit as never))).toBe(markdownSha);
    expect(sha256(`${JSON.stringify(audit, null, 2)}\n`)).toBe(jsonSha);
  });
});
