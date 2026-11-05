import type { SnapshotReleasePin } from "../../src/lib/safety-grade-snapshot";

/** Fixed release view for synthetic Markdown examples, independent of daily mirrors. */
export const MARKDOWN_FIXTURE_RELEASE: SnapshotReleasePin = {
  snapshotDate: "2026-10-22",
  assessments: { "usdt-tether": { grade: "A", score: 83, bucket: "safe" } },
};
