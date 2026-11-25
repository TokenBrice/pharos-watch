import Link from "next/link";
import {
  DISCLOSURE_SUMMARY_RESET_CLASS,
  DisclosureChevron,
} from "@/components/disclosure-panel";
import {
  CHANGELOG_TAG_LABELS,
  CHANGELOG_TAG_ORDER,
  formatChangelogDateRange,
  formatChangelogTagCountLabel,
  isMethodologySummaryHref,
  summarizeChangelogEntries,
  type ChangelogTag,
} from "@/lib/changelog-tags";
import { cn } from "@/lib/utils";
import type { ChangelogEntry } from "@shared/types/editorial-content";

const COMMIT_PREVIEW_COUNT = 20;

const TAG_CHIP_STYLES: Record<ChangelogTag, string> = {
  feature: "bg-state-info-subtle border-state-info text-state-info-bright",
  coverage: "bg-state-positive-subtle border-state-positive text-state-positive-bright",
  security: "bg-state-warn-subtle border-state-warn text-state-warn-bright",
  design: "bg-muted/55 border-border/60 text-muted-foreground",
  infra: "bg-muted/55 border-border/60 text-muted-foreground",
};

/** ISO 8601 week number derived from the closing date of the changelog window (UTC). */
function isoWeekNumber(ymd: string): number {
  const date = new Date(`${ymd}T00:00:00Z`);
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

interface ChangelogEntryCardProps {
  entry: ChangelogEntry;
  /** Render the first entry with elevated framing. */
  isLatest?: boolean;
}

export function ChangelogEntryCard({
  entry,
  isLatest,
}: ChangelogEntryCardProps) {
  const { dateRange, headline, fieldNotes, summary, stats, commits } = entry;
  const weekNumber = isoWeekNumber(dateRange.to);
  const headingId = `week-heading-${dateRange.to}`;
  const entrySummary = summarizeChangelogEntries([entry]);
  const activeTagCounts = CHANGELOG_TAG_ORDER.filter(
    (tag) => entrySummary.tagCounts[tag] > 0,
  );
  const missingTags = CHANGELOG_TAG_ORDER.filter(
    (tag) => entrySummary.tagCounts[tag] === 0,
  );
  const visibleCommits = commits.slice(0, COMMIT_PREVIEW_COUNT);
  const remainingCommits = Math.max(0, stats.totalCommits - visibleCommits.length);
  const commitsRangeUrl = `https://github.com/TokenBrice/pharos-watch/commits/main/?since=${dateRange.from}T00:00:00Z&until=${dateRange.to}T23:59:59Z`;

  return (
    <section
      id={dateRange.to}
      aria-labelledby={headingId}
      className={cn(
        "scroll-mt-32",
        isLatest && "pharos-card-shell px-4 py-5 sm:px-5 sm:py-6",
      )}
    >
      <p className="text-2xs leading-4 text-muted-foreground">
        Week <span className="pharos-numeric">#{weekNumber}</span>
      </p>
      <h2
        id={headingId}
        className={cn(
          "group/heading pharos-display mt-1 font-semibold tracking-tight text-foreground",
          isLatest ? "text-2xl" : "text-xl",
        )}
      >
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <a
            href={`#${dateRange.to}`}
            className="pharos-focus-ring rounded-sm no-underline hover:underline underline-offset-4"
          >
            <time dateTime={dateRange.to}>
              {formatChangelogDateRange(dateRange.from, dateRange.to)}
            </time>
            <span
              className="ml-2 text-muted-foreground opacity-0 transition-opacity select-none group-hover/heading:opacity-60 group-focus-within/heading:opacity-60"
              aria-hidden="true"
            >
              #
            </span>
          </a>
          {isLatest && (
            <span className="inline-flex items-center rounded-full border border-border/70 bg-background px-2 py-0.5 font-sans text-2xs font-semibold text-foreground">
              Latest
            </span>
          )}
        </span>
      </h2>

      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span>
          <span className="pharos-numeric text-foreground/90">{summary.length}</span>{" "}
          {summary.length === 1 ? "update" : "updates"}
        </span>
        {activeTagCounts.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-x-2">
            <span aria-hidden="true" className="text-muted-foreground/40">
              ·
            </span>
            <span>
              <span className="pharos-numeric text-foreground/90">
                {entrySummary.tagCounts[tag]}
              </span>{" "}
              {formatChangelogTagCountLabel(tag, entrySummary.tagCounts[tag])}
            </span>
          </span>
        ))}
        <span className="inline-flex items-center gap-x-2">
          <span aria-hidden="true" className="text-muted-foreground/40">
            ·
          </span>
          <span>
            <span className="pharos-numeric text-foreground/90">
              {stats.totalCommits}
            </span>{" "}
            {stats.totalCommits === 1 ? "commit" : "commits"}
          </span>
        </span>
      </p>

      {headline && (
        <p className="mt-3 max-w-[68ch] text-base font-medium leading-snug text-foreground">
          {headline}
        </p>
      )}

      {fieldNotes && (
        <div className="mt-4 border-l-2 border-border/70 pl-4">
          <p className="pharos-label">Editor&apos;s note</p>
          <p className="mt-1.5 max-w-[68ch] text-sm leading-relaxed text-foreground/85">
            {fieldNotes}
          </p>
        </div>
      )}

      {summary.length > 0 ? (
        <ul
          data-changelog-list=""
          data-has-feature={entrySummary.tagCounts.feature > 0 ? "true" : undefined}
          data-has-coverage={entrySummary.tagCounts.coverage > 0 ? "true" : undefined}
          data-has-security={entrySummary.tagCounts.security > 0 ? "true" : undefined}
          data-has-design={entrySummary.tagCounts.design > 0 ? "true" : undefined}
          data-has-infra={entrySummary.tagCounts.infra > 0 ? "true" : undefined}
          className="mt-5 mb-5 divide-y divide-border/50"
        >
          {summary.map((item) => {
            const isMethodologyLink = isMethodologySummaryHref(item.href);
            return (
              <li
                key={item.label}
                data-changelog-item=""
                data-tag={item.tag}
                className="space-y-1 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {item.href ? (
                    <Link
                      href={item.href}
                      className="pharos-focus-ring rounded-sm text-sm font-semibold text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
                    >
                      {item.label}
                      {"\u00a0\u2192"}
                    </Link>
                  ) : (
                    <span className="text-sm font-semibold text-foreground">
                      {item.label}
                    </span>
                  )}
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center rounded-sm border px-1.5 py-0.5 text-2xs font-medium",
                      TAG_CHIP_STYLES[item.tag],
                    )}
                  >
                    {CHANGELOG_TAG_LABELS[item.tag]}
                  </span>
                  {isMethodologyLink && (
                    <span className="inline-flex shrink-0 items-center rounded-sm border border-border/60 bg-background px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
                      Methodology
                    </span>
                  )}
                </div>
                <p className="max-w-[68ch] text-sm leading-relaxed text-muted-foreground">
                  {item.description}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}

      {missingTags.map((tag) => (
        <p
          key={tag}
          data-changelog-empty={tag}
          className="mt-5 mb-5 hidden text-sm text-muted-foreground"
        >
          No {CHANGELOG_TAG_LABELS[tag].toLowerCase()} items this week.
        </p>
      ))}

      <details className="group/disclosure">
        <summary
          className={cn(
            DISCLOSURE_SUMMARY_RESET_CLASS,
            "inline-flex min-h-11 w-fit items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors select-none hover:text-foreground sm:min-h-8",
          )}
        >
          <DisclosureChevron className="h-3.5 w-3.5" />
          <span>
            {remainingCommits > 0 ? (
              <>
                Recent commits (
                <span className="pharos-numeric">{visibleCommits.length}</span> of{" "}
                <span className="pharos-numeric">{stats.totalCommits}</span>)
              </>
            ) : (
              <>
                Recent commits (
                <span className="pharos-numeric">{stats.totalCommits}</span>)
              </>
            )}
          </span>
        </summary>
        <ul className="mt-2.5 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
          {visibleCommits.map((c) => (
            <li key={c.hash} className="flex items-baseline gap-2">
              <a
                href={`https://github.com/TokenBrice/pharos-watch/commit/${c.hash}`}
                className="pharos-focus-ring pharos-numeric shrink-0 rounded-sm text-foreground/75 underline decoration-border underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground"
                target="_blank"
                rel="noopener noreferrer"
              >
                {c.hash.slice(0, 8)}
              </a>
              <span className="min-w-0 text-muted-foreground">{c.message}</span>
            </li>
          ))}
        </ul>
        {remainingCommits > 0 && (
          <p className="mt-2.5 text-xs text-muted-foreground">
            {"\u2026"} <span className="pharos-numeric">{remainingCommits}</span>{" "}
            more filtered {remainingCommits === 1 ? "commit" : "commits"} {"\u00b7"}{" "}
            <a
              href={commitsRangeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="pharos-prose-link"
            >
              browse the week on GitHub{"\u00a0\u2192"}
            </a>
          </p>
        )}
      </details>
    </section>
  );
}
