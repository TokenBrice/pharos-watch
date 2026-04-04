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
  summary: SummaryItem[];
  stats: { totalCommits: number };
  commits: CommitRef[];
}
