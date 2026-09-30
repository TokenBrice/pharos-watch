import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { formatUtcDayLabel } from "@shared/lib/format";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { CemeteryDatasetCopyCitation } from "@/components/cemetery/cemetery-dataset-copy";
import { CemeterySectionHeader } from "@/components/cemetery/cemetery-section-header";
import { buttonVariants } from "@/components/ui/button";
import { CEMETERY_DATASET_META, CEMETERY_FEED_MAX_ITEMS, type CemeteryDatasetMeta } from "@/lib/cemetery-dataset-meta";

/** Daily digest channel; the digest appends new cemetery entries. */
const TELEGRAM_CHANNEL_URL = "https://t.me/pharoswatch";
/** Cemetery event class on the Timeline, all time (the Timeline defaults to 7 days). */
const TIMELINE_CEMETERY_HREF = "/timeline/?type=cemetery.*&window=alltime";

const LINK_BUTTON_CLASS = buttonVariants({ variant: "outline", size: "sm", className: "pharos-focus-ring" });

/** `updatedAt` is the latest record's `recordedAt`: when a record was last added, not a last-edit time. */
function formatLatestRecordAdded(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return formatUtcDayLabel(new Date(Date.UTC(year, month - 1, day)));
}

export function buildCemeteryDatasetCitation(meta: CemeteryDatasetMeta = CEMETERY_DATASET_META): string {
  const latest = meta.updatedAt ? `, latest record added ${formatLatestRecordAdded(meta.updatedAt)}` : "";
  return `Pharos, "Stablecoin Cemetery Dataset," schema ${meta.schemaVersion}, ${meta.rowCount} records${latest}. ${SITE_ORIGIN}${meta.jsonUrl} (${meta.license}).`;
}

function DatasetLink({ href, children, external = false }: { href: string; children: ReactNode; external?: boolean }) {
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={LINK_BUTTON_CLASS}>
        {children}
        <ExternalLink aria-hidden="true" className="size-3" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    );
  }
  return (
    <a href={href} className={LINK_BUTTON_CLASS}>
      {children}
    </a>
  );
}

/** "Download and cite": the published export, its feeds, and a copyable citation. Resolves the Dataset JSON-LD `@id`. */
export function CemeteryDataset() {
  const meta = CEMETERY_DATASET_META;
  const citation = buildCemeteryDatasetCitation(meta);
  const facts = [
    `${meta.rowCount} records`,
    `schema ${meta.schemaVersion}`,
    `${meta.license} license`,
    meta.updatedAt ? `latest record added ${formatLatestRecordAdded(meta.updatedAt)}` : null,
  ].filter((part): part is string => part !== null);

  return (
    <section id="dataset" aria-labelledby="dataset-heading" className="scroll-mt-24 space-y-3">
      <CemeterySectionHeader id="dataset-heading" kicker="Dataset" title="Download and cite" meta="Each coin ended. Its record stays." />

      <div className="pharos-card-shell overflow-hidden">
        <div className="grid lg:grid-cols-2">
          <div className="min-w-0 space-y-3 px-4 py-4 md:px-5 md:py-5">
            <p className="pharos-numeric text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
              {facts.join(" · ")} · checksum <span className="normal-case">{meta.sourceChecksumShort}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <DatasetLink href={meta.jsonUrl}>JSON</DatasetLink>
              <DatasetLink href={meta.csvUrl}>CSV</DatasetLink>
              <DatasetLink href={meta.rssUrl}>RSS feed</DatasetLink>
              <DatasetLink href={TELEGRAM_CHANNEL_URL} external>
                Telegram channel
              </DatasetLink>
              <Link href={TIMELINE_CEMETERY_HREF} className={LINK_BUTTON_CLASS}>
                Cemetery events on the Timeline
              </Link>
            </div>
            <p className="pharos-meta">
              New records are appended to the daily Telegram digest. The RSS feed carries the {CEMETERY_FEED_MAX_ITEMS} most
              recent deaths.
            </p>
          </div>

          <div className="min-w-0 space-y-3 border-t border-border/60 px-4 py-4 md:px-5 md:py-5 lg:border-l lg:border-t-0">
            <h3 className="pharos-kicker">How to cite</h3>
            <p className="rounded-md border border-border/50 bg-card/40 px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground/80 [overflow-wrap:anywhere]">
              {citation}
            </p>
            <CemeteryDatasetCopyCitation citation={citation} />
          </div>
        </div>
      </div>
    </section>
  );
}
