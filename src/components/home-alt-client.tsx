"use client";

import { useEffect, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { HomeSectionErrorBoundary } from "@/components/home-section-error-boundary";
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
import { buildStablecoinUrl } from "@shared/lib/urls";
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

const RANKINGS_SKELETON_HEADERS = ["#", "Name", "Price", "Peg", "Market cap", "24h", "7d", "Grade"] as const;
const RANKINGS_HEADER_VISIBILITY: Record<string, string> = {
  Peg: "hidden sm:table-cell",
  "24h": "hidden md:table-cell",
  "7d": "hidden lg:table-cell",
  Grade: "hidden md:table-cell",
};

const STATIC_PROFILE_LINKS = HOMEPAGE_TOP_CORE_STABLECOINS.slice(0, 8);

function HomepageStaticProfileDirectory(): React.JSX.Element {
  return (
    <nav aria-label="Core stablecoin profiles" className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">Core stablecoin profiles</p>
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
function RankingsSectionFallback() {
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
            <TableSkeletonRows columns={RANKINGS_SKELETON_COLUMNS} rowCount={20} rowClassName="h-14" />
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

function HorizonFallback(): React.JSX.Element {
  return (
    <div className="space-y-3">
      <Skeleton className="h-7 w-44" />
      <Skeleton className="h-28 w-full lg:h-52" />
    </div>
  );
}

const HomeAltUpcomingHorizonConstellation = dynamic(
  () => import("@/components/home-alt-upcoming-horizon-constellation").then((mod) => mod.HomeAltUpcomingHorizonConstellation),
  {
    ssr: false,
    loading: HorizonFallback,
  },
);

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

// Include headings that exist only after their deferred chunk mounts.
const HASH_TARGET_SECTIONS: Readonly<Record<string, string>> = {
  "home-alt-rankings": "rankings",
  "home-alt-rankings-title": "rankings",
  "upcoming-horizon-constellation-title": "horizon",
  "ddr-overview-title": "ddr",
  "yield-overview-title": "yield",
  "home-alt-status-telegram-title": "status",
};

/** Resolve an initial anchor after hydration without activating unrelated data. */
function useHashTargetForceMount() {
  const [target, setTarget] = useState<{ id: string; section: string } | null>(null);
  useEffect(() => {
    let id: string;
    try {
      id = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      return;
    }
    const section = Object.hasOwn(HASH_TARGET_SECTIONS, id) ? HASH_TARGET_SECTIONS[id] : undefined;
    if (!section) return;
    // The initial hash is browser-only; preserve server/first-client markup.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTarget({ id, section });
  }, []);

  useEffect(() => {
    if (!target) return;
    const scrollToTarget = () => {
      const element = document.getElementById(target.id);
      if (!element) return false;
      element.scrollIntoView({ block: "start" });
      return true;
    };
    if (scrollToTarget()) return;
    // A heading inside a dynamic section may arrive after this effect. Wait
    // for that actual target, not a timer or every other section's payload.
    const observer = new MutationObserver(() => {
      if (scrollToTarget()) observer.disconnect();
    });
    const root = document.getElementById("data");
    if (root) observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [target]);
  return target?.section;
}

// Reserves are the measured rendered heights (390 base / 1440 `lg:`), as static
// Tailwind classes: an under-reserved section shifts the footer on mount (CLS),
// an over-reserved one only leaves whitespace while it is in view.
function BelowFold({
  forced,
  reserveClassName,
  rootMargin,
  placeholder,
  children,
}: {
  forced: boolean;
  reserveClassName: string;
  rootMargin?: string;
  placeholder?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <LazySection className={reserveClassName} rootMargin={rootMargin} forceMount={forced} placeholder={placeholder}>
      {children}
    </LazySection>
  );
}

export function HomeAltClient({ children }: { children?: ReactNode }) {
  const hashTargetSection = useHashTargetForceMount();

  return (
    <div id="data" tabIndex={-1}>
      <div className="space-y-3">
        <BelowFold forced={false} reserveClassName="min-h-[1396px] lg:min-h-[594px]" rootMargin="0px">
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
          forced={hashTargetSection === "rankings"}
          reserveClassName="min-h-[1230px] lg:min-h-[1015px]"
          rootMargin="0px"
          placeholder={<RankingsSectionFallback />}
        >
          <HomeAltRankingsSection titleId="home-alt-rankings-title" />
        </BelowFold>
      </section>

      <BelowFold forced={hashTargetSection === "horizon"} reserveClassName="min-h-[212px] lg:min-h-[335px]">
        <div className="mt-8 sm:mt-10">
          <HomeAltUpcomingHorizonConstellation />
        </div>
      </BelowFold>

      <BelowFold forced={hashTargetSection === "ddr"} reserveClassName="min-h-[1340px] lg:min-h-[626px]">
        <div className="mt-8 sm:mt-10">
          <HomeSectionErrorBoundary name="depeg forecasting overview">
            <HomeAltDdrOverview />
          </HomeSectionErrorBoundary>
        </div>
      </BelowFold>

      <BelowFold forced={hashTargetSection === "yield"} reserveClassName="min-h-[564px] lg:min-h-[489px]">
        <div className="mt-8 sm:mt-10">
          <HomeSectionErrorBoundary name="yield intelligence overview">
            <HomeAltYieldOverview />
          </HomeSectionErrorBoundary>
        </div>
      </BelowFold>

      {children}

      <BelowFold forced={hashTargetSection === "status"} reserveClassName="min-h-[83px] lg:min-h-[53px]">
        <div className="mt-8 sm:mt-10">
          <HomeSectionErrorBoundary name="status and telegram overview">
            <HomeAltStatusTelegram />
          </HomeSectionErrorBoundary>
        </div>
      </BelowFold>
    </div>
  );
}
