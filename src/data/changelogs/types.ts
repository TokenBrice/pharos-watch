export interface CommitRef {
  hash: string;
  message: string;
}

export type SummaryTag = "feature" | "security" | "coverage" | "infra" | "design";

export interface SummaryItem {
  label: string;
  description: string;
  tag?: SummaryTag;
  href?: string;
}

export interface ChangelogEntry {
  dateRange: { from: string; to: string };
  /** One-sentence thesis summarising the release's biggest moves. */
  headline?: string;
  /**
   * Optional editor's note for the week — Courier-italic prose, ≤80 words,
   * rendered above the structural summary list. Treat as a recurring
   * column slot ("Field Notes") that frames what the week was about
   * beyond the commit list.
   */
  fieldNotes?: string;
  summary: SummaryItem[];
  stats: { totalCommits: number };
  commits: CommitRef[];
}
