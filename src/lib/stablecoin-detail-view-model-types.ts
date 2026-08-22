import type { SupplyHistoryPoint } from "@shared/types";
import type { ApiMeta } from "@/lib/api";
import type {
  MintAuthorityDetailViewModel,
  StablecoinDetailCoinMeta,
} from "@/lib/stablecoin-detail-mint-authority-view-model";
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
  StablecoinData,
  StablecoinListResponse,
  StressSignalEntry,
  StressSignalsAllResponse,
  YieldRanking,
  YieldRankingsResponse,
} from "@shared/types";
import type { V9ConsumerCard } from "@/lib/safety-score-v9-consumers";

export interface DetailQueryResource<TData> {
  data?: TData;
  isLoading?: boolean;
  dataUpdatedAt: number;
  error: unknown | null;
  meta: ApiMeta | null;
}

export interface DetailSupplyHistoryInput {
  data?: SupplyHistoryPoint[];
  isLoading: boolean;
  error: unknown | null;
  dataUpdatedAt: number;
}

export interface DetailStablecoinListInput extends DetailQueryResource<StablecoinListResponse> {
  isLoading: boolean;
  isError: boolean;
}

export interface StablecoinDetailViewModelQueryInputs {
  supplyHistory: DetailSupplyHistoryInput;
  stablecoinList: DetailStablecoinListInput;
  pegSummary: DetailQueryResource<PegSummaryResponse>;
  dexLiquidity: DetailQueryResource<DexLiquidityMap>;
  reportCards: DetailQueryResource<ReportCardsV9CurrentResponse>;
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
}

export type StablecoinDetailFeatureStatus = GatedQueryViewState;

export interface StablecoinDetailFeatureState {
  status: StablecoinDetailFeatureStatus;
  dataUpdatedAt: number;
  error: unknown | null;
}

export interface StablecoinDetailFeatureStates {
  liquidity: StablecoinDetailFeatureState;
  yield: StablecoinDetailFeatureState;
  stress: StablecoinDetailFeatureState;
  flows: StablecoinDetailFeatureState;
  blacklist: StablecoinDetailFeatureState;
  reserves: StablecoinDetailFeatureState;
}

export type StablecoinDetailSummary = StablecoinAiSummary;

interface BaseViewModel { handleRetryAll: () => void }
interface LoadingViewModel extends BaseViewModel { status: "loading" }
interface ListErrorViewModel extends BaseViewModel { status: "list-error"; listError: unknown }
interface NotFoundViewModel extends BaseViewModel { status: "not-found" }

export interface StablecoinDetailReadyViewModel extends BaseViewModel {
  status: "ready";
  id: string;
  coin: StablecoinDetailCoinMeta;
  summary: StablecoinDetailSummary | null;
  logoSrc?: string;
  reportCard: V9ConsumerCard | undefined;
  reportCardsResponse: ReportCardsV9CurrentResponse | undefined;
  reportCardUpdatedAt: number | null;
  variantParent: StablecoinClientMeta | null;
  variantSiblings: StablecoinClientMeta[];
  childVariants: StablecoinClientMeta[];
  isVariant: boolean;
  hasVariants: boolean;
  coinData: StablecoinData;
  mcap: number;
  supply: number | null;
  prevDay: number | null;
  prevWeek: number | null;
  prevMonth: number | null;
  performanceVsUsd1y: number | null;
  pegRef: number | null;
  deviationBps: number | null;
  gaugeDeviationBps: number;
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
  earliestTrackingDate: number | null;
  reserves: ReserveResult | null;
  reserveFetchError: unknown | null;
  supplyError: unknown | null;
  staleQueries: StablecoinDetailStaleQuery[];
  featureStates: StablecoinDetailFeatureStates;
  verdict: StablecoinVerdict;
  mintAuthority: MintAuthorityDetailViewModel;
}

export type StablecoinDetailViewModel =
  | LoadingViewModel
  | ListErrorViewModel
  | NotFoundViewModel
  | StablecoinDetailReadyViewModel;

export interface StablecoinDetailViewModelCoreInputs {
  id: string;
  coin: StablecoinDetailCoinMeta;
  summary: StablecoinDetailSummary | null;
  logoSrc?: string;
  handleRetryAll: () => void;
}

export interface BuildStablecoinDetailViewModelParams {
  core: StablecoinDetailViewModelCoreInputs;
  queries: StablecoinDetailViewModelQueryInputs;
  supplemental: StablecoinDetailViewModelSupplementalInputs;
}
