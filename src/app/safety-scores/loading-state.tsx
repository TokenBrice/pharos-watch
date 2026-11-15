import { FeatureHeroSplit } from "@/components/feature-hero-split";
import { Skeleton } from "@/components/ui/skeleton";
import type { SafetyScoresPreview } from "@/lib/safety-grade-snapshot";
import { SafetyMapPreview } from "./map-preview";
import { SafetyPillarExplainer, SafetyPillarScoringNote } from "./pillar-explainer";
import { StaticSafetyScoresPreview } from "./static-preview";

// Analytics tier: split instrument hero, filter band, then the dated preview
// or ~12 neutral graded-row placeholders when no preview is admissible.
const SAFETY_SKELETON_ROW_COUNT = 12;

/** The live hero's frame with neutral stat slots and the LCP map teaser; no preview-derived number. */
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
          <Skeleton className="h-48 w-full rounded-md" variant="shimmer" />
        </div>
        <SafetyMapPreview />
      </div>
    </FeatureHeroSplit>
  );
}

/**
 * Server-renderable (no client directive, no live module): the page prerenders
 * it into the first flush and the live client's pending branch renders the
 * same tree, so the handoff changes no markup.
 */
export function SafetyScoresContentLoadingState({ preview = null }: { preview?: SafetyScoresPreview | null }) {
  return (
    <>
      <SafetyScoresHeroSkeleton />

      {/* With a dated preview, the static explainer keeps the live layout's
          order so the grid does not jump when live cards replace it. */}
      {preview ? (
        <>
          <SafetyPillarExplainer />
          <SafetyPillarScoringNote />
        </>
      ) : null}

      <div className="pharos-card-shell space-y-3 p-4">
        <Skeleton className="h-3.5 w-32 rounded-sm" />
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-8 w-16 rounded-full" />
          ))}
        </div>
        <Skeleton className="h-12 w-full rounded-md" />
      </div>

      {preview ? (
        <StaticSafetyScoresPreview preview={preview} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: SAFETY_SKELETON_ROW_COUNT }).map((_, index) => (
            <div key={index} className="pharos-card-shell space-y-3 p-4">
              <div className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-24 rounded-sm" />
                  <Skeleton className="h-3 w-16 rounded-sm" />
                </div>
                <Skeleton className="h-7 w-10 rounded-md" />
              </div>
              <Skeleton className="h-2 w-full rounded-full" />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
