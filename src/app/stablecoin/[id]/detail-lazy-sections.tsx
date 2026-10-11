"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

type DetailSectionsBundle = typeof import("@/components/stablecoin-detail/sections-bundle");
type DetailSectionName = {
  [Name in keyof DetailSectionsBundle]: DetailSectionsBundle[Name] extends React.ComponentType<infer _Props>
    ? Name
    : never;
}[keyof DetailSectionsBundle];
type DetailSectionProps<Name extends DetailSectionName> =
  DetailSectionsBundle[Name] extends React.ComponentType<infer Props> ? Props : never;

function DetailSectionSkeleton({ className }: { className: string }) {
  return <Skeleton className={className} />;
}

function lazyDetailSection<Name extends DetailSectionName>(name: Name, className: string) {
  type Props = DetailSectionProps<Name>;

  return dynamic<Props>(
    () =>
      import("@/components/stablecoin-detail/sections-bundle").then(
        (mod) => mod[name] as unknown as React.ComponentType<Props>,
      ),
    { loading: () => <DetailSectionSkeleton className={className} /> },
  );
}

export const FeedbackModal = dynamic(
  () => import("@/components/feedback-modal").then((mod) => mod.FeedbackModal),
  // The null fallback is load-bearing: without a `loading` option, `dynamic()`
  // adds no local Suspense boundary, the chunk-load suspension bubbles to the
  // page-level boundary, and the whole detail island collapses mid-scroll.
  { ssr: false, loading: () => null },
);

export const McapChart = lazyDetailSection("McapChart", "h-[420px] w-full rounded-xl");
export const MarketDataSection = lazyDetailSection("MarketDataSection", "h-[420px] w-full rounded-xl");
export const DEWSDetail = lazyDetailSection("DEWSDetail", "h-[320px] w-full rounded-xl");
export const StablecoinSafetyScoreV9Card = lazyDetailSection(
  "StablecoinSafetyScoreV9Card",
  "h-[420px] w-full rounded-xl",
);
export const ReservesSection = lazyDetailSection("ReservesSection", "h-[320px] w-full rounded-xl");
export const HistoryTabs = lazyDetailSection("HistoryTabs", "h-[360px] w-full rounded-xl");

export const FlowsSection = lazyDetailSection("FlowsSection", "h-[320px] w-full rounded-xl");
export const FlowHistorySection = lazyDetailSection("FlowHistorySection", "h-[320px] w-full rounded-xl");
export const BlacklistSection = lazyDetailSection("BlacklistSection", "h-[320px] w-full rounded-xl");
export const BlacklistHistorySection = lazyDetailSection("BlacklistHistorySection", "h-[320px] w-full rounded-xl");
export const PegStabilityCard = lazyDetailSection("PegStabilityCard", "h-[320px] w-full rounded-xl");
export const YieldDetailSection = lazyDetailSection("YieldDetailSection", "h-[420px] w-full rounded-xl");
export const DexLiquidityCard = lazyDetailSection("DexLiquidityCard", "h-[360px] w-full rounded-xl");
export const DistributionSection = lazyDetailSection("DistributionSection", "h-[320px] w-full rounded-xl");
export const StablecoinDepegResolverCard = lazyDetailSection(
  "StablecoinDepegResolverCard",
  "h-[420px] w-full rounded-xl",
);
