import Link from "next/link";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { Card, CardContent } from "@/components/ui/card";
import type { SafetyScoresPreview, SafetyScoresPreviewRow } from "@/lib/safety-grade-snapshot";

const PREVIEW_GRID_CLASS =
  "grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";

function PreviewCard({ row }: { row: SafetyScoresPreviewRow }) {
  return (
    <Link
      href={row.href}
      prefetch={false}
      title={`${row.name} (${row.symbol})`}
      className="pharos-focus-ring block h-full rounded-xl transition-transform active:scale-[0.995]"
    >
      <Card className="pharos-card-shell pharos-interactive-card h-full min-h-[274px] cursor-pointer gap-0 py-0">
        <CardContent className="relative flex flex-col items-center justify-center gap-2.5 px-2 pb-3 pt-3 sm:px-4">
          <div className="flex min-w-0 max-w-full items-center gap-2">
            <span className="truncate text-sm font-medium" title={row.name}>{row.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{row.symbol}</span>
          </div>
          <SafetyGradeBadge grade={row.grade} size="lg" />
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
            <span className="pharos-numeric text-sm font-semibold text-foreground">{row.score}/100</span>
            {row.provisional ? (
              <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-2xs font-medium text-muted-foreground">
                Provisional
              </span>
            ) : null}
            {row.gradeHoldRawGrade ? (
              <span
                className="rounded-full border border-border/60 px-2 py-0.5 text-2xs font-medium text-muted-foreground"
                title={`Published letter retained; this score's raw band is ${row.gradeHoldRawGrade}.`}
              >
                Grade held
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/**
 * Static, bounded result set for the build-time preview. It is the same
 * component in the dynamic loader fallback and the query-pending branch, so
 * the dated facts survive hydration unchanged.
 */
export function StaticSafetyScoresPreview({ preview }: { preview: SafetyScoresPreview }) {
  const publishedIso = new Date(preview.publishedAtSec * 1000).toISOString();
  return (
    <section id="data" aria-label="Safety score cards" tabIndex={-1}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link
          href={`/datasets/scores-latest/${preview.snapshotDate}.json`}
          prefetch={false}
          className="pharos-focus-ring rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <time dateTime={publishedIso}>Grades as of {preview.snapshotDate}</time>
        </Link>
        <span className="text-xs text-muted-foreground">
          Top {preview.shownCount} of {preview.eligibleRatedCount} rated active stablecoins by Safety Score
        </span>
      </div>
      <div className={PREVIEW_GRID_CLASS}>
        {preview.rows.map((row) => (
          <PreviewCard key={row.id} row={row} />
        ))}
      </div>
    </section>
  );
}
