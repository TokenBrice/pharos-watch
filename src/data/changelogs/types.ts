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
  summary: SummaryItem[];
  stats: { totalCommits: number };
  commits: CommitRef[];
}
