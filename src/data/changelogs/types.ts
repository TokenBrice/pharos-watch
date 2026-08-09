export interface CommitRef {
  hash: string;
  message: string;
}

export type SummaryTag = "feature" | "security" | "coverage" | "infra" | "design";

export type SummaryHref = `/${string}`;

export interface SummaryItem {
  label: string;
  description: string;
  tag: SummaryTag;
  /** Internal absolute path, for example `/methodology/`; external URLs are not valid here. */
  href?: SummaryHref;
}

export interface ChangelogEntry {
  /**
   * Both `from` and `to` MUST be `YYYY-MM-DD` ISO date strings. The barrel sort
   * in `index.ts` and the year-grouping in the changelog page rely on
   * lexicographic comparison, which is only correct for this exact format.
   */
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
  /**
   * `totalCommits` is the number of commits in the date window after noise
   * filtering. It is the authoritative count and MAY exceed `commits.length`.
   */
  stats: { totalCommits: number };
  /**
   * The rendered commit list, capped at the 20 the changelog card shows.
   * Anything beyond that is counted by `stats.totalCommits` and archived in
   * git history — do not re-expand this array.
   */
  commits: CommitRef[];
}
