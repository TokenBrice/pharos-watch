"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

function DetailSectionSkeleton({ className }: { className: string }) {
  return <Skeleton className={className} />;
}

export const FeedbackModal = dynamic(
  () => import("@/components/feedback-modal").then((mod) => mod.FeedbackModal),
  // The null fallback keeps the chunk-load suspension out of the page-level
  // Suspense boundary (see DdrTrackRecordSection below).
  { ssr: false, loading: () => null },
);

export const McapChart = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.McapChart),
  { loading: () => <DetailSectionSkeleton className="h-[420px] w-full rounded-xl" /> },
);

export const MarketDataSection = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.MarketDataSection),
  { loading: () => <DetailSectionSkeleton className="h-[420px] w-full rounded-xl" /> },
);

export const DEWSDetail = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.DEWSDetail),
  { loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" /> },
);

export const StablecoinSafetyScoreV9Card = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.StablecoinSafetyScoreV9Card),
  { loading: () => <DetailSectionSkeleton className="h-[420px] w-full rounded-xl" /> },
);

export const ReservePanel = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.ReservePanel),
  { loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" /> },
);

export const DepegHistory = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.DepegHistory),
  { loading: () => <DetailSectionSkeleton className="h-[360px] w-full rounded-xl" /> },
);

// Explicit null fallback, not a skeleton: the module renders nothing until the
// review query resolves and stays absent for coins with no reviewed forecast,
// so a skeleton would promise content most coins never have. The fallback
// option itself is load-bearing — without one, `dynamic()` adds no local
// Suspense boundary, the chunk-load suspension bubbles to the page-level
// boundary, and the whole detail island collapses to the dossier shell
// mid-scroll (the scroll position then clamps ~11k px up the page).
export const DdrTrackRecordSection = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.DdrTrackRecordSection),
  { loading: () => null },
);

export const FlowsSection = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.FlowsSection),
  { loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" /> },
);

export const FlowHistorySection = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.FlowHistorySection),
  { loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" /> },
);

export const BlacklistSection = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.BlacklistSection),
  { loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" /> },
);

export const BlacklistHistorySection = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.BlacklistHistorySection),
  { loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" /> },
);

export const PegStabilityCard = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.PegStabilityCard),
  { loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" /> },
);

export const YieldDetailSection = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.YieldDetailSection),
  { loading: () => <DetailSectionSkeleton className="h-[420px] w-full rounded-xl" /> },
);

export const DexLiquidityCard = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.DexLiquidityCard),
  { loading: () => <DetailSectionSkeleton className="h-[360px] w-full rounded-xl" /> },
);

export const DistributionSection = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.DistributionSection),
  { loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" /> },
);

export const SafetyScoreHistorySection = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.SafetyScoreHistorySection),
  { loading: () => <DetailSectionSkeleton className="h-[220px] w-full rounded-xl" /> },
);

export const StablecoinDepegResolverCard = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.StablecoinDepegResolverCard),
  { loading: () => <DetailSectionSkeleton className="h-[420px] w-full rounded-xl" /> },
);
