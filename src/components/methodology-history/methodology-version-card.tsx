import Link from "next/link";
import {
  DISCLOSURE_SUMMARY_RESET_CLASS,
  DisclosureChevron,
  DisclosurePanel,
} from "@/components/disclosure-panel";
import { StructuredChangelogDetail } from "@/components/methodology-history/methodology-changelog-detail";
import {
  formatMethodologyDisplayDate,
  toMethodologyVersionLabel,
} from "@shared/lib/methodology-versions/base";
import { cn } from "@/lib/utils";
import type { MethodologyChangelogEntry } from "@shared/types/editorial-content";

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-full border border-border/60 bg-muted/55 px-2.5 py-0.5 text-xs pharos-numeric font-medium text-foreground">
      {children}
    </span>
  );
}

export function MethodologyVersionCard({
  entry,
  entryId,
  defaultOpen = false,
  archiveHref,
}: {
  entry: MethodologyChangelogEntry;
  entryId?: string;
  defaultOpen?: boolean;
  archiveHref?: string;
}) {
  const dateLabel = formatMethodologyDisplayDate(entry.date);

  return (
    <details
      id={entryId}
      open={defaultOpen}
      className="pharos-card-shell group/disclosure scroll-mt-36 overflow-hidden"
    >
      <summary
        className={cn(
          DISCLOSURE_SUMMARY_RESET_CLASS,
          "px-5 py-4 transition-colors hover:bg-muted/30 sm:px-6",
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Pill>{toMethodologyVersionLabel(entry.version)}</Pill>
              <Pill>{dateLabel}</Pill>
              {entry.reconstructed && <Pill>Reconstructed</Pill>}
            </div>
            <div className="space-y-1.5">
              <h2 className="pharos-section-title">{entry.title}</h2>
              <p className="max-w-[72ch] text-sm leading-relaxed text-muted-foreground">{entry.summary}</p>
            </div>
          </div>
          <span className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span className="group-open/disclosure:hidden">Details</span>
            <span className="hidden group-open/disclosure:inline">Hide details</span>
            <DisclosureChevron />
          </span>
        </div>
      </summary>
      <div className="space-y-4 border-t border-border/50 px-5 pb-5 pt-4 text-sm leading-relaxed text-muted-foreground sm:px-6">
        {entry.impact.length > 0 && (
          <div className="pharos-inset px-4 py-3">
            <p className="pharos-label">Impact notes</p>
            <ul className="mt-2.5 grid gap-2 sm:grid-cols-2">
              {entry.impact.map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-[0.42rem] h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/40" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {entry.detail && <StructuredChangelogDetail entry={entry} />}
        {archiveHref && (
          <div>
            <Link href={archiveHref} prefetch={false} className="pharos-prose-link text-xs text-foreground">
              Open full version archive{"\u00a0\u2192"}
            </Link>
          </div>
        )}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5 border-t border-border/50 pt-3 text-xs text-muted-foreground">
          {entry.reconstructed && <span>Reconstructed from git commit history.</span>}
          {entry.commits.length === 0 ? (
            <span>Commit provenance not recorded</span>
          ) : entry.commits.length <= 4 ? (
            <span className="break-words">
              Commits: <span className="pharos-numeric text-foreground/85">{entry.commits.join(", ")}</span>
            </span>
          ) : (
            <DisclosurePanel
              variant="plain"
              chevronPosition="end"
              summary={
                <span className="pharos-numeric">
                  {entry.commits.length} commits
                </span>
              }
            >
              <p className="break-words pharos-numeric text-xs text-foreground/85">
                {entry.commits.join(", ")}
              </p>
            </DisclosurePanel>
          )}
        </div>
      </div>
    </details>
  );
}
