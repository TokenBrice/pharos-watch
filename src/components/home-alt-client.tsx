"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";

import { useHomepageDiscoverySuggestions } from "@/hooks/use-homepage-discovery";

import { HomepageDiscoveryModule } from "@/components/homepage-discovery-module";
import { LazySection } from "@/components/lazy-section";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TableBody,
  TableCaption,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeletonRows,
  type TableSkeletonColumn,
} from "@/components/table";

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

function DailyDigestFallback() {
  return (
    <div className="min-h-[560px] animate-pulse border-y border-border py-6 lg:min-h-[660px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-3 w-36" />
      </div>
      <div className="grid gap-6 py-6 lg:grid-cols-[minmax(0,0.64fr)_minmax(0,1.36fr)] lg:gap-10">
        <div className="space-y-4">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-40 w-full max-w-[20rem] sm:max-w-[24rem] lg:h-64" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-9/12" />
        </div>
      </div>
    </div>
  );
}

const HomeAltMiniCardGrid = dynamic(
  () => import("@/components/home-alt-mini-card-grid").then((mod) => mod.HomeAltMiniCardGrid),
  {
    ssr: false,
    loading: MiniCardGridFallback,
  },
);

const DailyDigest = dynamic(
  () => import("@/components/daily-digest").then((mod) => mod.DailyDigest),
  {
    ssr: false,
    loading: DailyDigestFallback,
  },
);

/* Approximates the loaded table's column rhythm (rank · coin · 6 numeric/badge
 * columns) so the reserved space reads as the table arriving, not a void. */
const RANKINGS_SKELETON_COLUMNS: readonly TableSkeletonColumn[] = [
  { id: "rank", cellClassName: "w-10", skeletonClassName: "h-4 w-5" },
  { id: "name", skeletonClassName: "h-4 w-36" },
  { id: "price", cellClassName: "text-right", skeletonClassName: "ml-auto h-4 w-14" },
  { id: "peg", cellClassName: "text-right hidden sm:table-cell", skeletonClassName: "ml-auto h-4 w-12" },
  { id: "mcap", cellClassName: "text-right", skeletonClassName: "ml-auto h-4 w-16" },
  { id: "change24h", cellClassName: "text-right hidden md:table-cell", skeletonClassName: "ml-auto h-4 w-12" },
  { id: "change7d", cellClassName: "text-right hidden lg:table-cell", skeletonClassName: "ml-auto h-4 w-12" },
  { id: "grade", cellClassName: "text-center hidden md:table-cell", skeletonClassName: "mx-auto h-4 w-7" },
];

const RANKINGS_SKELETON_HEADERS = ["#", "Coin", "Price", "Peg", "Market Cap", "24h", "7d", "Grade"] as const;
const RANKINGS_HEADER_VISIBILITY: Record<string, string> = {
  Peg: "hidden sm:table-cell",
  "24h": "hidden md:table-cell",
  "7d": "hidden lg:table-cell",
  Grade: "hidden md:table-cell",
};

function RankingsSectionFallback() {
  return (
    <div className="space-y-4">
      {/* Peg browse strip placeholder */}
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-full" />
        ))}
      </div>
      <TableFrame
        tableId="stablecoin-overview-loading"
        topSlot={
          <div className="pharos-table-toolbar flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1.5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-5 w-48" />
            </div>
            <Skeleton className="h-8 w-40" />
          </div>
        }
      >
        <TableCaption className="sr-only">Stablecoin data table loading</TableCaption>
        <TableHeader className="bg-muted">
          <TableRow rowIntent="static">
            {RANKINGS_SKELETON_HEADERS.map((label) => (
              <TableHead key={label} scope="col" className={RANKINGS_HEADER_VISIBILITY[label]}>
                {label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableSkeletonRows columns={RANKINGS_SKELETON_COLUMNS} rowCount={10} />
        </TableBody>
      </TableFrame>
    </div>
  );
}

const HomeAltRankingsSection = dynamic(
  () => import("@/components/home-alt-rankings-section").then((mod) => mod.HomeAltRankingsSection),
  {
    ssr: false,
    loading: RankingsSectionFallback,
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
  placeholder,
  children,
}: {
  forced: boolean;
  minHeight: number;
  rootMargin?: string;
  placeholder?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (forced) return <>{children}</>;
  return (
    <LazySection minHeight={minHeight} rootMargin={rootMargin} placeholder={placeholder}>
      {children}
    </LazySection>
  );
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

      {/* The directory table is the product's workbench — it follows the KPI
          band directly; the editorial band reads after it (mythos #8). */}
      <section
        id="home-alt-rankings"
        role="region"
        aria-labelledby="home-alt-rankings-title"
        className="mt-3 space-y-4 sm:mt-3.5"
      >
        <BelowFold
          forced={hashTargetForcesMount}
          minHeight={620}
          rootMargin="0px"
          placeholder={<RankingsSectionFallback />}
        >
          <HomeAltRankingsSection titleId="home-alt-rankings-title" />
        </BelowFold>
      </section>

      {/* Editorial band — single hairline divides it from the workbench above */}
      <BelowFold forced={hashTargetForcesMount} minHeight={820}>
        <section
          aria-label="Daily digest"
          className="mt-8 pt-2.5 sm:mt-10 sm:pt-3"
        >
          <DailyDigest variant="preview" />
        </section>

        <div className="mt-3 sm:mt-3.5">
          <HomepageDiscoveryModule suggestions={discoverySuggestions} />
        </div>
      </BelowFold>
    </div>
  );
}
