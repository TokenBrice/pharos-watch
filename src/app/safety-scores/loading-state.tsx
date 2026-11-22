import { ChartSkeleton } from "@/components/chart-skeleton";
import { FeatureHeroSplit } from "@/components/feature-hero-split";
import { PageLoadingRowList } from "@/components/page-loading-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import type { SafetyScoresPreview } from "@/lib/safety-grade-snapshot";
import { SafetyMapPreview } from "./map-preview";
import { SafetyPillarExplainer, SafetyPillarScoringNote } from "./pillar-explainer";
import { StaticSafetyScoresPreview } from "./static-preview";

// Analytics tier: split instrument hero, filter band, then the dated preview
// or ~12 neutral matrix-row placeholders when no preview is admissible.
const SAFETY_SKELETON_ROW_COUNT = 12;

/** The live hero's frame with neutral stat slots, framed bar skeleton, and the LCP map teaser; no preview-derived number. */
function SafetyScoresHeroSkeleton() {
  return (
    <FeatureHeroSplit
      ariaLabel="Ecosystem safety overview"
      beamLabel={<span className="inline-block h-3.5 w-28 animate-pulse rounded-sm bg-accent" />}
      beamValue={<span className="inline-block h-10 w-32 animate-pulse rounded-md bg-accent" />}
      universe={<Skeleton className="h-6 w-40 rounded-full" />}
      expand={{ href: "#data", label: "Jump to the full grade table" }}
      subKicker="Ecosystem read"
      sub={
        <div className="space-y-3 py-2">
          <Skeleton className="h-4 w-full rounded-sm" />
          <Skeleton className="h-4 w-4/5 rounded-sm" />
        </div>
      }
    >
      <div className="grid h-full gap-4 p-5 sm:p-6 lg:grid-cols-3 lg:p-7">
        <div className="flex min-w-0 flex-col justify-center lg:col-span-2">
          <ChartSkeleton variant="bars" className="h-48 w-full" aria-hidden />
        </div>
        <SafetyMapPreview />
      </div>
    </FeatureHeroSplit>
  );
}

/**
 * The page prerenders this into the first flush. The live island keeps those
 * nodes mounted while the query is pending and the preview remains eligible.
 */
export function SafetyScoresContentLoadingState({ preview = null }: { preview?: SafetyScoresPreview | null }) {
  return (
    <>
      <SafetyScoresHeroSkeleton />

      {/* With a dated preview, the static explainer keeps the live layout's
          order so the view does not jump when live ratings replace it. */}
      {preview ? (
        <>
          <SafetyPillarExplainer />
          <SafetyPillarScoringNote />
        </>
      ) : null}

      <div className="pharos-card-shell space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-9 w-56 rounded-md" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-28 rounded-lg" />
            <Skeleton className="h-8 w-20 rounded-md" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-8 w-16 rounded-full" />
          ))}
        </div>
      </div>

      {preview ? (
        <StaticSafetyScoresPreview preview={preview} />
      ) : (
        <PageLoadingRowList
          rowCount={SAFETY_SKELETON_ROW_COUNT}
          titleWidth="w-40"
          actionWidth="w-24"
          avatarClassName="h-6 w-6 rounded-full"
          primaryWidth="w-28"
          secondaryWidth="w-20"
          metricWidths={["w-14", "w-14", "w-14", "w-14", "w-16"]}
          metricContainerClassName="hidden sm:flex"
          mobileMetricWidth="w-12"
        />
      )}
    </>
  );
}
