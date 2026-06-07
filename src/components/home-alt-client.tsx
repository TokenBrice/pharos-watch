"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";

import { useHomepageDiscoverySuggestions } from "@/hooks/use-homepage-discovery";

import { HomepageDiscoveryModule } from "@/components/homepage-discovery-module";
import { LazySection } from "@/components/lazy-section";
import { Skeleton } from "@/components/ui/skeleton";

function MiniCardGridFallback() {
  return (
    <div className="@container space-y-3">
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}

const HomeAltMiniCardGrid = dynamic(
  () => import("@/components/home-alt-mini-card-grid").then((mod) => mod.HomeAltMiniCardGrid),
  {
    loading: MiniCardGridFallback,
  },
);

const DailyDigest = dynamic(
  () => import("@/components/daily-digest").then((mod) => mod.DailyDigest),
  {
    loading: () => <Skeleton className="h-32 w-full" />,
  },
);

const HomeAltRankingsSection = dynamic(
  () => import("@/components/home-alt-rankings-section").then((mod) => mod.HomeAltRankingsSection),
  {
    loading: () => (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-[480px] w-full" />
      </div>
    ),
  },
);

/**
 * M14 — force-mount below-fold panels when the URL carries an anchor so the
 * browser can resolve the scroll target. Hash changes during the session
 * don't matter; the lazy gate has long since unmounted by then.
 */
function useHashTargetForceMount() {
  const [forced, setForced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash && window.location.hash !== "#") {
      // One-shot setState that runs only when the URL arrives with a hash.
      // The empty dep array guarantees it never re-fires, so the cascade
      // lint rule is a false positive here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForced(true);
    }
  }, []);
  return forced;
}

function BelowFold({
  forced,
  minHeight,
  rootMargin,
  children,
}: {
  forced: boolean;
  minHeight: number;
  rootMargin?: string;
  children: React.ReactNode;
}) {
  if (forced) return <>{children}</>;
  return <LazySection minHeight={minHeight} rootMargin={rootMargin}>{children}</LazySection>;
}

export function HomeAltClient() {
  const hashTargetForcesMount = useHashTargetForceMount();
  const discoverySuggestions = useHomepageDiscoverySuggestions();

  return (
    <div id="data" tabIndex={-1}>
      <div className="space-y-3">
        <BelowFold forced={hashTargetForcesMount} minHeight={520} rootMargin="0px">
          <HomeAltMiniCardGrid />
        </BelowFold>
      </div>

      {/* Editorial band — single hairline divides it from the dashboard above */}
      <BelowFold forced={hashTargetForcesMount} minHeight={220}>
        <section
          aria-label="Daily digest"
          className="mt-3 pt-2.5 sm:mt-3.5 sm:pt-3"
        >
          <DailyDigest variant="preview" />
        </section>

        <div className="mt-3 sm:mt-3.5">
          <HomepageDiscoveryModule suggestions={discoverySuggestions} />
        </div>
      </BelowFold>

      <section
        id="home-alt-rankings"
        role="region"
        aria-labelledby="home-alt-rankings-title"
        className="mt-8 space-y-4 sm:mt-10"
      >
        <BelowFold
          forced={hashTargetForcesMount}
          minHeight={620}
          rootMargin="0px 0px -65% 0px"
        >
          <HomeAltRankingsSection titleId="home-alt-rankings-title" />
        </BelowFold>
      </section>
    </div>
  );
}
