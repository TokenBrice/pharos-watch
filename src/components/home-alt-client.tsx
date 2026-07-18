"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { HomeAltUpcomingHorizonConstellation } from "@/components/home-alt-upcoming-horizon-constellation";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { ShortcutsSection } from "@/components/shortcuts-section";
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
import { buildStablecoinUrl } from "@/lib/urls";
import { HOMEPAGE_TOP_CORE_STABLECOINS } from "@/lib/stablecoin-static-data";

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
    ssr: false,
    loading: MiniCardGridFallback,
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

const RANKINGS_SKELETON_HEADERS = ["#", "Name", "Price", "Peg", "Market Cap", "24h", "7d", "Grade"] as const;
const RANKINGS_HEADER_VISIBILITY: Record<string, string> = {
  Peg: "hidden sm:table-cell",
  "24h": "hidden md:table-cell",
  "7d": "hidden lg:table-cell",
  Grade: "hidden md:table-cell",
};

const STATIC_PROFILE_LINKS = HOMEPAGE_TOP_CORE_STABLECOINS.slice(0, 8);

export function HomepageStaticProfileDirectory(): React.JSX.Element {
  return (
    <nav aria-label="Leading stablecoin profiles" className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">Market leaders</p>
        <Link
          href="/screener/"
          className="pharos-focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          Open full screener
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      </div>
      <ul className="grid grid-cols-2 overflow-hidden rounded-lg border border-border/70 sm:grid-cols-4">
        {STATIC_PROFILE_LINKS.map((coin) => (
          <li
            key={coin.id}
            className="min-w-0 border-b border-r border-border/70 even:border-r-0 [&:nth-last-child(-n+2)]:border-b-0 sm:even:border-r sm:[&:nth-child(4n)]:border-r-0 sm:[&:nth-last-child(-n+4)]:border-b-0"
          >
            <Link
              href={buildStablecoinUrl(coin.id)}
              className="pharos-focus-ring flex min-h-14 min-w-0 flex-col justify-center px-3 py-2 transition-colors hover:bg-muted/40"
            >
              <span className="truncate text-sm font-medium text-foreground">{coin.symbol}</span>
              <span className="truncate text-xs text-muted-foreground">{coin.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* Mirrors the loaded section's order — header, external toolbar, table shell,
 * peg browse strip beneath — so content doesn't jump when the chunk mounts. */
export function RankingsSectionFallback() {
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <h2
          id="home-alt-rankings-title"
          className="pharos-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl"
        >
          Stablecoin Overview
        </h2>
        <p className="text-sm text-muted-foreground">
          Compare market size, peg health, liquidity, and safety across the stablecoin market.
        </p>
      </div>
      <HomepageStaticProfileDirectory />
      <div className="space-y-3">
        {/* External toolbar placeholder (figmaOverview renders it above the shell) */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-9 w-64 max-w-full" />
          <Skeleton className="h-9 w-40" />
        </div>
        <TableFrame tableId="stablecoin-overview-loading">
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
      {/* Peg browse strip placeholder */}
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-full" />
        ))}
      </div>
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

/* Below-fold overview modules (after On The Horizon) are code-split and SSR-off:
 * each owns a live hook, so deferring the chunk keeps them off the homepage's
 * critical path. This generic skeleton reserves the header+panel rhythm for the
 * brief chunk-download window; each module then renders its own loading state. */
function ModuleFallback(): React.JSX.Element {
  return (
    <div className="space-y-3 sm:space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-7 w-24 rounded-md" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/* The status strip is a single slim row, so it reserves a much shorter band
 * than the header+panel modules above it. */
function StatusStripFallback(): React.JSX.Element {
  return (
    <div className="pharos-card-shell flex flex-col gap-x-4 gap-y-1.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <Skeleton className="h-5 w-60" />
      <Skeleton className="h-5 w-44" />
    </div>
  );
}

const HomeAltDdrOverview = dynamic(
  () => import("@/components/home-alt-ddr-overview").then((mod) => mod.HomeAltDdrOverview),
  {
    ssr: false,
    loading: ModuleFallback,
  },
);

const HomeAltYieldOverview = dynamic(
  () => import("@/components/home-alt-yield-overview").then((mod) => mod.HomeAltYieldOverview),
  {
    ssr: false,
    loading: ModuleFallback,
  },
);

const HomeAltStatusTelegram = dynamic(
  () => import("@/components/home-alt-status-telegram").then((mod) => mod.HomeAltStatusTelegram),
  {
    ssr: false,
    loading: StatusStripFallback,
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

  return (
    <div id="data" tabIndex={-1}>
      <div className="space-y-3">
        <BelowFold forced={hashTargetForcesMount} minHeight={520} rootMargin="0px">
          <HomeAltMiniCardGrid />
        </BelowFold>
      </div>

      {/* Saved shortcuts sit between the pulse band and the directory table. */}
      <div className="mt-5 sm:mt-6">
        <ShortcutsSection />
      </div>

      {/* The directory table is the product's workbench — it follows the
          shortcuts directly. */}
      <section
        id="home-alt-rankings"
        role="region"
        aria-labelledby="home-alt-rankings-title"
        className="mt-5 space-y-4 sm:mt-6"
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

      <BelowFold forced={hashTargetForcesMount} minHeight={520}>
        <div className="mt-8 sm:mt-10">
          <HomeAltUpcomingHorizonConstellation />
        </div>
      </BelowFold>

      <BelowFold forced={hashTargetForcesMount} minHeight={360}>
        <div className="mt-8 sm:mt-10">
          <SectionErrorBoundary name="depeg forecasting overview">
            <HomeAltDdrOverview />
          </SectionErrorBoundary>
        </div>
      </BelowFold>

      <BelowFold forced={hashTargetForcesMount} minHeight={420}>
        <div className="mt-8 sm:mt-10">
          <SectionErrorBoundary name="yield intelligence overview">
            <HomeAltYieldOverview />
          </SectionErrorBoundary>
        </div>
      </BelowFold>

      <BelowFold forced={hashTargetForcesMount} minHeight={120}>
        <div className="mt-8 sm:mt-10">
          <SectionErrorBoundary name="status and telegram overview">
            <HomeAltStatusTelegram />
          </SectionErrorBoundary>
        </div>
      </BelowFold>
    </div>
  );
}
