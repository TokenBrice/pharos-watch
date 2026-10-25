import type { SupplyHistoryPoint } from "@shared/types";
import type { NativeSupplyCheckpoints, StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";
import type { ApiMeta, SavedSafetyAssessment } from "@/lib/api";
import type { MintAuthorityDetailViewModel } from "@/lib/stablecoin-detail-mint-authority-view-model";
import type { HeroCardViewModel } from "@/lib/stablecoin-detail-hero-view-model";
import type { StablecoinDetailCoinMeta } from "@/lib/stablecoin-detail-client-coin";
import type { GatedQueryViewState } from "@/lib/query-view-state";
import type { StablecoinVerdict } from "@shared/lib/stablecoin-verdict";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type { StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import type {
  BlacklistStablecoin,
  BlacklistSummaryResponse,
  DexLiquidityData,
  DexLiquidityMap,
  MintBurnFlowsResponse,
  PegSummaryCoin,
  PegSummaryResponse,
  RedemptionBackstopEntry,
  RedemptionBackstopsResponse,
  ReportCardsV9CurrentResponse,
  StablecoinAiSummary,
  StressSignalEntry,
  StressSignalsAllResponse,
  YieldRanking,
  YieldRankingsResponse,
} from "@shared/types";
import type { V9ConsumerCard } from "@/lib/safety-score-v9-consumers";
import type { ReportCardsV9DetailResponse } from "@shared/types/report-cards-v9-projections";

export interface DetailQueryResource<TData> {
  data?: TData;
  isLoading?: boolean;
  dataUpdatedAt: number;
  error: unknown | null;
  meta: ApiMeta | null;
  enabled?: boolean;
}

export interface DetailSupplyHistoryInput extends DetailQueryResource<SupplyHistoryPoint[]> {
  isLoading: boolean;
}

/** Detail quote plus registry-only presentation context; never a fabricated list row. */
export type DetailQuote = Pick<StablecoinLiveSummary,
  "price" | "priceSource" | "priceConfidence" | "priceUpdatedAt" | "priceObservedAt"
  | "priceObservedAtMode" | "priceSyncedAt" | "nominalPriceReference" | "supplyRestored"
> & Partial<Pick<StablecoinLiveSummary, "supplyObservedAt" | "supplyExcludedChains">> & { pegType: string; chains: string[] };

export interface StablecoinDetailViewModelQueryInputs {
  supplyHistory: DetailSupplyHistoryInput;
  /** Eligible assets only; independent of the initial chart's 90-day window. */
  annualPriceHistory?: DetailSupplyHistoryInput;
  liveSummary: DetailQueryResource<StablecoinLiveSummary>;
  pegSummary: DetailQueryResource<PegSummaryResponse>;
  dexLiquidity: DetailQueryResource<DexLiquidityMap>;
  reportCards: DetailQueryResource<ReportCardsV9CurrentResponse | ReportCardsV9DetailResponse>;
  redemptionBackstops: DetailQueryResource<RedemptionBackstopsResponse>;
}

export interface DetailFlowsInput {
  data?: MintBurnFlowsResponse;
  isLoading: boolean;
  error: unknown | null;
  dataUpdatedAt: number;
  meta: ApiMeta | null;
  enabled: boolean;
}

export interface DetailBlacklistInput {
  summary?: BlacklistSummaryResponse;
  isLoading: boolean;
  error: unknown | null;
  dataUpdatedAt: number;
  meta: ApiMeta | null;
  enabled: boolean;
}

export interface DetailReservesInput {
  live?: ReserveResult | null;
  error?: unknown | null;
  dataUpdatedAt: number;
  isLoading: boolean;
  enabled: boolean;
}

export interface StablecoinDetailViewModelSupplementalInputs {
  yieldRankings: DetailQueryResource<YieldRankingsResponse> & { isLoading: boolean };
  stressSignals: DetailQueryResource<StressSignalsAllResponse> & { isLoading: boolean };
  flows: DetailFlowsInput;
  blacklist: DetailBlacklistInput;
  reserves: DetailReservesInput;
  nowMs?: number;
}

export interface StablecoinDetailStaleQuery {
  preset?:
    | "stablecoins"
    | "pegSummary"
    | "dexLiquidity"
    | "reportCards"
    | "redemptionBackstops"
    | "yieldRankings"
    | "stressSignals"
    | "mintBurnFlows"
    | "blacklist";
  label?: string;
  staleTime?: number;
  dataUpdatedAt: number;
  error: unknown | null;
  hasData: boolean;
  meta: ApiMeta | null;
  enabled?: boolean;
  /** First fetch in flight: the freshness banner waits instead of reporting "not populated". */
  isLoading?: boolean;
}

export type StablecoinDetailFeatureStatus = GatedQueryViewState;

export interface StablecoinDetailFeatureState {
  status: StablecoinDetailFeatureStatus;
  dataUpdatedAt: number;
  error: unknown | null;
}

/** Empty is authoritative only after a successful redemption response. */
export type DetailRedemptionReadState = "deferred" | "loading" | "unavailable" | "retained" | "empty" | "ready";

export interface StablecoinDetailFeatureStates {
  redemption: { status: DetailRedemptionReadState; dataUpdatedAt: number; error: unknown | null };
  reserves: StablecoinDetailFeatureState;
}

export type StablecoinDetailSummary = StablecoinAiSummary;

interface BaseViewModel { handleRetryAll: () => void }
interface LoadingViewModel extends BaseViewModel { status: "loading" }
interface ListErrorViewModel extends BaseViewModel { status: "list-error"; listError: unknown }

export interface StablecoinDetailReadyViewModel extends BaseViewModel {
  status: "ready";
  id: string;
  coin: StablecoinDetailCoinMeta;
  summary: StablecoinDetailSummary | null;
  logoSrc?: string;
  reportCard: V9ConsumerCard | undefined;
  reportCardsResponse: ReportCardsV9CurrentResponse | ReportCardsV9DetailResponse | undefined;
  reportCardUpdatedAt: number | null;
  variantParent: StablecoinClientMeta | null;
  variantSiblings: StablecoinClientMeta[];
  childVariants: StablecoinClientMeta[];
  isVariant: boolean;
  hasVariants: boolean;
  coinData: DetailQuote;
  mcap: number | null;
  supply: number | null;
  prevDay: number | null;
  nativeSupply: NativeSupplyCheckpoints | null;
  performanceVsUsd1y: number | null;
  pegRef: number | null;
  deviationBps: number | null;
  pegReferenceUnavailable: boolean;
  isNavToken: boolean;
  pegScoreResult: PegSummaryCoin | null;
  consensusSources: string[];
  agreeSources: string[];
  dexPriceCheck: PegSummaryCoin["dexPriceCheck"];
  liquidityData: DexLiquidityData | undefined;
  yieldRanking: YieldRanking | null;
  hasYieldSection: boolean;
  stressSignal: StressSignalEntry | null;
  redemptionBackstop: RedemptionBackstopEntry | undefined;
  hasFlows: boolean;
  hasBlacklist: boolean;
  blacklistSymbol: BlacklistStablecoin | null;
  supplyHistory: SupplyHistoryPoint[];
  /** Supply query freshness (ms) for the Market Data header chip. */
  supplyUpdatedAt: number;
  reserves: ReserveResult | null;
  reserveFetchError: unknown | null;
  supplyError: unknown | null;
  staleQueries: StablecoinDetailStaleQuery[];
  featureStates: StablecoinDetailFeatureStates;
  verdict: StablecoinVerdict;
  mintAuthority: MintAuthorityDetailViewModel;
  hero: HeroCardViewModel;
}

export type StablecoinDetailViewModel =
  | LoadingViewModel
  | ListErrorViewModel
  | StablecoinDetailReadyViewModel;

export interface StablecoinDetailViewModelCoreInputs {
  id: string;
  coin: StablecoinDetailCoinMeta;
  summary: StablecoinDetailSummary | null;
  logoSrc?: string;
  handleRetryAll: () => void;
  /** The build snapshot's dated scores-latest values; display-only while live reads are pending. */
  savedAssessment?: SavedSafetyAssessment | null;
}

export interface BuildStablecoinDetailViewModelParams {
  core: StablecoinDetailViewModelCoreInputs;
  queries: StablecoinDetailViewModelQueryInputs;
  supplemental: StablecoinDetailViewModelSupplementalInputs;
}
