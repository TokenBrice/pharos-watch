"use client";

import { useEffect, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { HomeSectionErrorBoundary } from "@/components/homepage/home-section-error-boundary";
import { ShortcutsSection } from "@/components/homepage/shortcuts-section";
import { LazySection } from "@/components/lazy-section";
import { Skeleton } from "@/components/ui/skeleton";
import { StablecoinOverviewSkeleton } from "@/components/stablecoin-directory/stablecoin-overview-skeleton";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { HOMEPAGE_TOP_CORE_STABLECOINS } from "@/lib/stablecoin-static-data";

function MiniCardGridFallback() {
  return (
    <>
      <div className="grid grid-cols-2 gap-2.5 md:hidden">
        <Skeleton className="h-[106px] w-full rounded-xl" />
        <Skeleton className="h-[106px] w-full rounded-xl" />
        <Skeleton className="h-[104px] w-full rounded-xl" />
        <Skeleton className="h-[104px] w-full rounded-xl" />
        <Skeleton className="h-[104px] w-full rounded-xl" />
        <Skeleton className="h-[104px] w-full rounded-xl" />
      </div>
      <div className="@container hidden space-y-3 md:block">
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
          <Skeleton className="h-80 w-full rounded-xl" />
          <Skeleton className="h-80 w-full rounded-xl" />
          <Skeleton className="h-80 w-full rounded-xl" />
        </div>
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
          <Skeleton className="h-56 w-full rounded-xl" />
          <Skeleton className="h-56 w-full rounded-xl" />
        </div>
      </div>
    </>
  );
}

const HomeAltMiniCardGrid = dynamic(
  () => import("@/components/homepage/home-alt-mini-card-grid").then((mod) => mod.HomeAltMiniCardGrid),
  {
    ssr: false,
    loading: MiniCardGridFallback,
  },
);

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

/* Mirrors the loaded section's order: header, crawlable core links, unified
 * StablecoinOverviewSkeleton, and peg browse strip beneath. */
function RankingsSectionFallback() {
  return (
    <div className="space-y-4">
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
      <StablecoinOverviewSkeleton showToolbar />
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-full" />
        ))}
      </div>
    </div>
  );
}

const HomeAltRankingsSection = dynamic(
  () => import("@/components/homepage/home-alt-rankings-section").then((mod) => mod.HomeAltRankingsSection),
  {
    ssr: false,
    loading: RankingsSectionFallback,
  },
);

function DigestStripFallback(): React.JSX.Element {
  return (
    <div className="pharos-card-shell grid grid-cols-1 gap-4 p-5 sm:p-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,5fr)_minmax(0,3fr)]">
      <div className="space-y-2.5">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-56" />
        <div className="flex gap-2 pt-1">
          <Skeleton className="h-8 w-28 rounded-md" />
          <Skeleton className="h-8 w-36 rounded-md" />
        </div>
      </div>
      <div className="space-y-2">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    </div>
  );
}

const DailyDigestCard = dynamic(
  () => import("@/components/home-alt-mini-cards/daily-digest-card").then((mod) => mod.DailyDigestCard),
  {
    ssr: false,
    loading: DigestStripFallback,
  },
);

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
  () => import("@/components/homepage/home-alt-upcoming-horizon-constellation").then((mod) => mod.HomeAltUpcomingHorizonConstellation),
  {
    ssr: false,
    loading: HorizonFallback,
  },
);

const HomeAltDdrOverview = dynamic(
  () => import("@/components/homepage/home-alt-ddr-overview").then((mod) => mod.HomeAltDdrOverview),
  {
    ssr: false,
    loading: ModuleFallback,
  },
);

const HomeAltYieldOverview = dynamic(
  () => import("@/components/homepage/home-alt-yield-overview").then((mod) => mod.HomeAltYieldOverview),
  {
    ssr: false,
    loading: ModuleFallback,
  },
);

const HomeAltStatusTelegram = dynamic(
  () => import("@/components/homepage/home-alt-status-telegram").then((mod) => mod.HomeAltStatusTelegram),
  {
    ssr: false,
    loading: StatusStripFallback,
  },
);

// Include headings that exist only after their deferred chunk mounts.
const HASH_TARGET_SECTIONS: Readonly<Record<string, string>> = {
  "home-alt-rankings": "rankings",
  "home-alt-rankings-title": "rankings",
  "daily-digest-title": "digest",
  "yield-overview-title": "yield",
  "upcoming-horizon-constellation-title": "horizon",
  "ddr-overview-title": "ddr",
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
    const observer = new MutationObserver(() => {
      if (scrollToTarget()) observer.disconnect();
    });
    const root = document.getElementById("data");
    if (root) observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [target]);
  return target?.section;
}

// Reserves are measured rendered heights (390 base / desktop `md:` or `lg:`),
// as static Tailwind classes so mounting deferred sections never shifts the footer.
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

export function HomeAltClient({
  blogBanner,
  children,
}: {
  blogBanner?: ReactNode;
  children?: ReactNode;
}) {
  const hashTargetSection = useHashTargetForceMount();

  return (
    <div id="data" tabIndex={-1}>
      {/* Band 3: Market Pulse Grid (Row 1 permanently leads with Active depegs;
          mobile compresses into a dense 2x3 KPI tile grid). */}
      <div className="space-y-3">
        <BelowFold forced={false} reserveClassName="min-h-[334px] md:min-h-[600px]" rootMargin="0px">
          <HomeAltMiniCardGrid />
        </BelowFold>
      </div>

      {/* Band 4: Server-rendered fresh blog banner below Market Pulse so Row 1
          sits cleanly above 1280x800 and 1440x900 desktop folds. */}
      {blogBanner ? <div className="mt-4 sm:mt-5">{blogBanner}</div> : null}

      {/* Band 5: Stablecoin Overview workbench with 300px viewport prefetch. */}
      <section
        id="home-alt-rankings"
        role="region"
        aria-labelledby="home-alt-rankings-title"
        className="mt-5 space-y-4 sm:mt-6"
      >
        <BelowFold
          forced={hashTargetSection === "rankings"}
          reserveClassName="min-h-[1230px] lg:min-h-[1015px]"
          rootMargin="300px"
          placeholder={<RankingsSectionFallback />}
        >
          <HomeAltRankingsSection titleId="home-alt-rankings-title" />
        </BelowFold>
      </section>

      {/* Band 6: Full-width Cross-Device Daily Digest Editorial Strip. */}
      <BelowFold forced={hashTargetSection === "digest"} reserveClassName="min-h-[260px] lg:min-h-[188px]">
        <div className="mt-8 sm:mt-10">
          <HomeSectionErrorBoundary name="daily digest">
            <DailyDigestCard />
          </HomeSectionErrorBoundary>
        </div>
      </BelowFold>

      {/* Band 7: Yield Intelligence (promoted ahead of On the horizon & DDR). */}
      <BelowFold forced={hashTargetSection === "yield"} reserveClassName="min-h-[564px] lg:min-h-[489px]">
        <div className="mt-8 sm:mt-10">
          <HomeSectionErrorBoundary name="yield intelligence overview">
            <HomeAltYieldOverview />
          </HomeSectionErrorBoundary>
        </div>
      </BelowFold>

      {/* Band 8: On the horizon & Depeg Duration Resolver. */}
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

      {/* Band 9: Curated 6-tool ShortcutsSection below Overview & modules. */}
      <div className="mt-8 sm:mt-10">
        <ShortcutsSection />
      </div>

      {/* Band 10: API / Media strips + Status / Telegram strip. */}
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
