import { Fragment } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ChangelogEntryCard } from "@/components/changelog-entry-card";
import { ChangelogWeekNav } from "@/components/changelog-week-nav";
import { buildPageMetadata } from "@/lib/page-metadata";
import { changelogs } from "@/data/changelogs";

export const metadata: Metadata = buildPageMetadata({
  title: "Changelog: What's New on Pharos",
  description:
    "Weekly release notes for Pharos — new stablecoin coverage, pipeline improvements, risk tooling updates, and more.",
  canonical: "/changelog/",
});

export default function ChangelogPage() {
  const years = new Set(
    changelogs.map((e) => new Date(e.dateRange.to + "T00:00:00").getFullYear()),
  );
  const multiYear = years.size > 1;

  return (
    <FeaturePageShell
      breadcrumbName="Changelog"
      path="/changelog/"
      title="Changelog"
      variant="longform"
      containerClassName="mx-auto max-w-3xl"
      leadParagraphs={[
        <>
          Weekly release notes. Follow{" "}
          <Link href="/telegram/" className="underline underline-offset-4 hover:text-foreground">
            @PharosWatch on Telegram
          </Link>{" "}
          for real-time alerts, or browse the{" "}
          <a
            href="https://github.com/TokenBrice/stablecoin-dashboard/commits/main/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            full commit history
          </a>{" "}
          on GitHub.
        </>,
      ]}
    >
      {changelogs.length >= 4 && <ChangelogWeekNav entries={changelogs} />}
      <ol className="relative ml-1.5 border-l border-border/50">
        {changelogs.map((entry, i) => {
          const year = new Date(entry.dateRange.to + "T00:00:00").getFullYear();
          const prevYear =
            i > 0
              ? new Date(changelogs[i - 1].dateRange.to + "T00:00:00").getFullYear()
              : year;
          const showYearDivider = multiYear && (i === 0 || year !== prevYear);

          return (
            <Fragment key={entry.dateRange.to}>
              {showYearDivider && (
                <li className={`relative pl-8 ${i > 0 ? "mt-14" : ""}`}>
                  <span className="text-sm font-mono font-medium text-muted-foreground/70">
                    {year}
                  </span>
                </li>
              )}
              <li
                className={`relative pl-8 ${showYearDivider ? "mt-4" : i > 0 ? "mt-14" : ""}`}
              >
                <div
                  className={`absolute -left-[5px] top-[7px] size-2.5 rounded-full ${
                    i === 0
                      ? "bg-frost-blue shadow-[0_0_0_4px_oklch(0.72_0.14_248/0.12)]"
                      : "border-2 border-border bg-background"
                  }`}
                  aria-hidden
                />
                <ChangelogEntryCard entry={entry} isLatest={i === 0} />
              </li>
            </Fragment>
          );
        })}
      </ol>
    </FeaturePageShell>
  );
}
