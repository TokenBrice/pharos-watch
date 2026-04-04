export interface CommitRef {
  hash: string;
  message: string;
}

export interface SummaryItem {
  label: string;
  description: string;
}

export interface ChangelogEntry {
  dateRange: { from: string; to: string };
  /** One-sentence thesis summarising the release's biggest moves. */
  headline?: string;
  summary: SummaryItem[];
  stats: { totalCommits: number };
  commits: CommitRef[];
}
