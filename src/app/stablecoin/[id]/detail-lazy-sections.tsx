"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

// Each literal client import is a section boundary: requesting one section must
// not fetch unrelated sections. next.config.ts keeps Recharts in one vendor
// group, so splitting the section entries does not duplicate the chart stack.
export const FeedbackModal = dynamic(
  () => import("@/components/feedback-modal").then((mod) => mod.FeedbackModal),
  // Keep suspension local instead of collapsing the whole detail island.
  { ssr: false, loading: () => null },
);

export const McapChart = dynamic(
  () => import("@/components/mcap-chart").then((mod) => mod.McapChart),
  { loading: () => <Skeleton className="h-[420px] w-full rounded-xl" /> },
);
export const MarketDataSection = dynamic(
  () => import("@/components/stablecoin-detail/market-data-section").then((mod) => mod.MarketDataSection),
  { loading: () => <Skeleton className="h-[420px] w-full rounded-xl" /> },
);
export const DEWSDetail = dynamic(
  () => import("@/components/dews-detail").then((mod) => mod.DEWSDetail),
  { loading: () => <Skeleton className="h-[320px] w-full rounded-xl" /> },
);
export const StablecoinSafetyScoreV9Card = dynamic(
  () => import("@/components/stablecoin-detail/stablecoin-safety-score-v9-card").then((mod) => mod.StablecoinSafetyScoreV9Card),
  { loading: () => <Skeleton className="h-[420px] w-full rounded-xl" /> },
);
export const ReservesSection = dynamic(
  () => import("@/components/stablecoin-detail/reserves-section").then((mod) => mod.ReservesSection),
  { loading: () => <Skeleton className="h-[320px] w-full rounded-xl" /> },
);
// C1: the History tab shell is synchronous so its retained-ledger preview is
// part of the initial HTML. Its live modules are literal dynamic imports
// inside `history-tabs.tsx`, behind the viewport and active-tab gates.
export { HistoryTabs } from "@/components/stablecoin-detail/history-tabs";
export const FlowsSection = dynamic(
  () => import("@/components/stablecoin-detail/flows-section").then((mod) => mod.FlowsSection),
  { loading: () => <Skeleton className="h-[320px] w-full rounded-xl" /> },
);
export const FlowHistorySection = dynamic(
  () => import("@/components/stablecoin-detail/flows-section").then((mod) => mod.FlowHistorySection),
  { loading: () => <Skeleton className="h-[320px] w-full rounded-xl" /> },
);
export const BlacklistSection = dynamic(
  () => import("@/components/stablecoin-detail/blacklist-section").then((mod) => mod.BlacklistSection),
  { loading: () => <Skeleton className="h-[320px] w-full rounded-xl" /> },
);
export const BlacklistHistorySection = dynamic(
  () => import("@/components/stablecoin-detail/blacklist-section").then((mod) => mod.BlacklistHistorySection),
  { loading: () => <Skeleton className="h-[320px] w-full rounded-xl" /> },
);
export const PegStabilityCard = dynamic(
  () => import("@/components/stablecoin-detail/peg-stability-card").then((mod) => mod.PegStabilityCard),
  { loading: () => <Skeleton className="h-[320px] w-full rounded-xl" /> },
);
export const YieldDetailSection = dynamic(
  () => import("@/components/yield-detail-section"),
  { loading: () => <Skeleton className="h-[420px] w-full rounded-xl" /> },
);
export const DexLiquidityCard = dynamic(
  () => import("@/components/dex-liquidity-card").then((mod) => mod.DexLiquidityCard),
  { loading: () => <Skeleton className="h-[360px] w-full rounded-xl" /> },
);
export const DistributionSection = dynamic(
  () => import("@/components/stablecoin-detail/distribution-section").then((mod) => mod.DistributionSection),
  { loading: () => <Skeleton className="h-[320px] w-full rounded-xl" /> },
);
export const StablecoinDepegResolverCard = dynamic(
  () => import("@/components/stablecoin-detail/depeg-resolver-card").then((mod) => mod.StablecoinDepegResolverCard),
  { loading: () => <Skeleton className="h-[420px] w-full rounded-xl" /> },
);
