import type { SnapshotReleasePin } from "../../src/lib/safety-grade-snapshot";

/**
 * Release view pinned for the authored Markdown byte fixtures, shared by the
 * snapshot test and refresh-markdown-export-fixtures. A refresh must reproduce
 * the committed bytes, so it renders this pin instead of the generated mirror
 * date that each daily dataset rebuild moves.
 */
export const MARKDOWN_FIXTURE_RELEASE: SnapshotReleasePin = {
  snapshotDate: "2026-10-22",
  assessments: { "usdt-tether": { grade: "A", score: 83, bucket: "safe" } },
};
