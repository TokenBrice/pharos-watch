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
          className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
        >
          {changelogs.map((entry) => (
            <a
              key={entry.dateRange.to}
              href={`#${entry.dateRange.to}`}
              className="pharos-focus-ring rounded-sm hover:text-foreground transition-colors"
            >
              {formatDateRange(entry.dateRange.from, entry.dateRange.to)}
            </a>
          ))}
        </nav>
      )}
      <div className="divide-y divide-border">
        {changelogs.map((entry, i) => (
          <div key={entry.dateRange.to} className="py-10 first:pt-0 last:pb-0">
            <ChangelogEntryCard entry={entry} isLatest={i === 0} />
          </div>
        ))}
      </div>
    </FeaturePageShell>
  );
}
