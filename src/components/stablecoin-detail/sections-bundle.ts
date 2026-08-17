/**
 * Single lazy bundle for the coin-detail page's deferred sections (Mythos
 * P1-5). Each section used to be its own `dynamic()` entry, so Turbopack
 * emitted a separate chunk per section with duplicated shared code (recharts
 * is ~358 KB raw / 105 KB gz per copy). Routing every section loader through
 * this one module collapses the per-section copies into one chunk for the
 * whole detail family (total recharts-attributed bytes: 4.10 MB -> 3.33 MB).
 *
 * Remaining duplication: route families with differing import graphs still
 * get their own recharts copy (/yield, /stability-index, ...). Turbopack
 * converges chunks when graphs match (this bundle's lazy recharts chunk is
 * also /alt-pegs' eager one); dedup by sharing one chart-kit module boundary.
 *
 * Keep chart-bearing detail sections OUT of static imports in client.tsx and
 * IN this bundle; the per-route eager-JS budget guards the eager side. The
 * /stablecoin/[id]/yield subpage defers its chart-bearing pieces through this
 * bundle too, so both routes share the same lazy chunk.
 */
export { McapChart } from "@/components/mcap-chart";
export { MarketDataSection } from "@/components/stablecoin-detail/market-data-section";
export { DEWSDetail } from "@/components/dews-detail";
export { StablecoinSafetyScoreV9Card } from "@/components/stablecoin-detail/stablecoin-safety-score-v9-card";
export { ReservePanel } from "@/components/stablecoin-detail/reserve-panel";
export { DepegHistory } from "@/components/depeg-history";
export { DdrTrackRecordSection } from "@/components/stablecoin-detail/ddr-track-record-section";
export { FlowsSection, FlowHistorySection } from "@/components/stablecoin-detail/flows-section";
export { BlacklistSection, BlacklistHistorySection } from "@/components/stablecoin-detail/blacklist-section";
export { PegStabilityCard } from "@/components/stablecoin-detail/peg-stability-card";
export { default as YieldDetailSection, YieldChangeAttributionCard } from "@/components/yield-detail-section";
export { YieldHistoryChart } from "@/components/yield-history-chart";
export { DexLiquidityCard } from "@/components/dex-liquidity-card";
export { DistributionSection } from "@/components/stablecoin-detail/distribution-section";
export { SafetyScoreHistorySection } from "@/components/stablecoin-detail/safety-score-history-section";
export { StablecoinDepegResolverCard } from "@/components/stablecoin-detail/depeg-resolver-card";
