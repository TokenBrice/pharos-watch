import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import {
  ChangelogEntryCard,
  formatDateRange,
} from "@/components/changelog-entry-card";
import { buildPageMetadata } from "@/lib/page-metadata";
import { changelogs } from "@/data/changelogs";

export const metadata: Metadata = buildPageMetadata({
  title: "Changelog: What's New on Pharos",
  description:
    "Weekly release notes for Pharos — new stablecoin coverage, pipeline improvements, risk tooling updates, and more.",
  canonical: "/changelog/",
});

export default function ChangelogPage() {
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
      {changelogs.length >= 4 && (
        <nav
          aria-label="Jump to release"
          className="flex flex-wrap gap-x-1 gap-y-1 text-xs font-mono text-muted-foreground"
        >
          {changelogs.map((entry, i) => (
            <a
              key={entry.dateRange.to}
              href={`#${entry.dateRange.to}`}
              className="pharos-focus-ring rounded-md px-2 py-1 hover:bg-muted hover:text-foreground transition-colors"
            >
              {formatDateRange(entry.dateRange.from, entry.dateRange.to)}
              {i === 0 && (
                <span className="ml-1.5 text-[10px] font-sans font-medium text-frost-blue">
                  latest
                </span>
              )}
            </a>
          ))}
        </nav>
      )}
      <ol className="relative ml-1.5 border-l border-border/50">
        {changelogs.map((entry, i) => (
          <li
            key={entry.dateRange.to}
            className={`relative pl-8 ${i > 0 ? "mt-14" : ""}`}
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
        ))}
      </ol>
    </FeaturePageShell>
  );
}
