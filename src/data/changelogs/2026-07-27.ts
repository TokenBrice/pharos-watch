import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-07-27", to: "2026-07-27" },
  headline: "Safety Score V9 becomes the active model with fail-closed publication and held-rating continuity.",
  fieldNotes:
    "V9 now serves identity-aware consumers. Its publication fence separates real risk movement from transient worker failures: unhealthy attempts retain the last accepted ratings, report held status, and never fall back to V8.",
  summary: [
    {
      label: "Safety Score V9 activation",
      tag: "feature",
      href: "/methodology/",
      description:
        "The three-pillar V9 model becomes active under the 9.0 policy identity, with Backing, Exit, and Economic Control bounded by evidence and structural failure paths.",
    },
    {
      label: "Graceful degradation",
      tag: "infra",
      href: "/methodology/scoring-changelog/",
      description:
        "Stale or failed score-bearing inputs and new infrastructure-attributed downgrades hold the last accepted V9 snapshot instead of replacing it or recomputing V8.",
    },
  ],
  stats: { totalCommits: 1 },
  commits: [
    { hash: "1e7eaba0", message: "fix(safety-score): keep V9 fence within runtime budget" },
  ],
};
