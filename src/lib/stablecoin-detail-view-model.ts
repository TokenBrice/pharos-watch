import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";
import type {
  BlacklistSummaryResponse,
  DexLiquidityData,
  DexLiquidityMap,
  Infrastructure,
  MintBurnFlowsResponse,
  PegSummaryCoin,
  PegSummaryResponse,
  RedemptionBackstopsResponse,
  ReportCard,
  ReportCardsResponse,
  StablecoinAiSummary,
  StablecoinData,
  MechanismArchetype,
  StablecoinListResponse,
  StablecoinMeta,
  RedemptionBackstopEntry,
  StressSignalEntry,
  StressSignalsAllResponse,
  VariantKind,
  YieldRanking,
  YieldRankingsResponse,
} from "@shared/types";
import type { BlacklistStablecoin } from "@shared/types";
import type { MintAuthorityClientSummary } from "@shared/types/stablecoin-client-meta";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import {
  getCirculatingRaw,
  getPrevDayRawOrNull,
  getPrevMonthRawOrNull,
  getPrevWeekRawOrNull,
} from "@shared/lib/supply";
import { CLIENT_TRACKED_META_BY_ID, type StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import { buildExplorerUrl } from "@shared/lib/explorer";
import {
  deriveDeviationBps,
  deriveGaugeDeviationBps,
  derivePegReferenceContext,
  deriveSupplyFromMarketCap,
} from "@/lib/stablecoin-detail-derive";
import type { ApiMeta } from "@/lib/api";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { isThreatBand } from "@shared/lib/classification";
import { deriveStablecoinVerdict, type StablecoinVerdict } from "@shared/lib/stablecoin-verdict";
import { getReserves } from "@shared/lib/reserve-templates";
import { buildLiveCompareUrl, getPrimaryStaticComparisonLinkForCoin } from "@/lib/compare-links";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import { isQuietDeviationsEnabled } from "@/lib/feature-flags";
import { getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import {
  mintAuthorityScoreTextClassName,
  resolveMintAuthorityScoreDisplay,
  type MintAuthorityScoreDisplay,
} from "@/lib/mint-authority-display";
import { projectMintAuthorityClientSummary } from "@/lib/stablecoin-detail-mint-authority-client";
import { getVariantDisplay } from "@/lib/variant-display";
import { getClientVariantParent, getClientVariantRelationship, getClientVariants } from "@/lib/client-variant-registry";
import {
  HERO_MUTED_CLASS,
  HERO_NEGATIVE_TREND_CLASS,
  HERO_POSITIVE_TREND_CLASS,
  buildDewsAccent,
  buildDewsDisplay,
  buildExcessYieldDisplay,
  buildLimitedDepegCoverageNote,
  buildLiquidityAccent,
  buildLiquidityDisplay,
  buildPegScoreAccent,
  buildPegScoreDisplay,
  buildPerformanceVsUsdDisplay,
  type HeroDewsDisplay,
  type HeroDisplayValue,
} from "@/lib/stablecoin-detail-hero-metrics";

export type { HeroDewsDisplay, HeroDisplayValue } from "@/lib/stablecoin-detail-hero-metrics";
import { buildHeroPassportItems, type HeroPassportItemViewModel } from "@/lib/stablecoin-detail-passport";
export type { HeroPassportItemViewModel } from "@/lib/stablecoin-detail-passport";

const YEAR_SECONDS = 365 * DAY_SECONDS;
const YEARLY_PERFORMANCE_ANCHOR_TOLERANCE_SECONDS = 14 * DAY_SECONDS;

export interface DetailQueryResource<TData> {
  data?: TData;
  dataUpdatedAt: number;
  error: unknown | null;
  meta: ApiMeta | null;
}

export interface DetailSupplyHistoryInput {
  data?: SupplyHistoryPoint[];
  isLoading: boolean;
  error: unknown | null;
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
  reportCards: DetailQueryResource<ReportCardsResponse>;
  redemptionBackstops: DetailQueryResource<RedemptionBackstopsResponse>;
}

export interface DetailFlowsInput {
  data?: MintBurnFlowsResponse;
  isLoading: boolean;
}

export interface DetailBlacklistInput {
  summary?: BlacklistSummaryResponse;
  isLoading: boolean;
}

export interface DetailReservesInput {
  live?: ReserveResult | null;
  error?: unknown | null;
}

export interface StablecoinDetailViewModelSupplementalInputs {
  yieldRankingsData?: YieldRankingsResponse;
  stressSignalsData?: StressSignalsAllResponse;
  flows: DetailFlowsInput;
  blacklist: DetailBlacklistInput;
  reserves: DetailReservesInput;
  nowMs?: number;
}

export type StablecoinDetailStaleQuery = {
  preset: "stablecoins" | "pegSummary" | "dexLiquidity" | "reportCards" | "redemptionBackstops";
  dataUpdatedAt: number;
  error: unknown | null;
  hasData: boolean;
  meta: ApiMeta | null;
};

export type MarketSnapshot = {
  mcap: number;
  supply: number | null;
  prevDay: number | null;
  prevWeek: number | null;
  prevMonth: number | null;
  performanceVsUsd1y: number | null;
  earliestTrackingDate: number | null;
};

export type PegPriceSnapshot = {
  pegRef: number;
  deviationBps: number;
  gaugeDeviationBps: number;
  pegReferenceUnavailable: boolean;
  pegScoreResult: PegSummaryCoin | null;
  consensusSources: string[];
  agreeSources: string[];
  dexPriceCheck: PegSummaryCoin["dexPriceCheck"];
};

export type FeatureAvailabilitySnapshot = {
  yieldRanking: YieldRanking | null;
  hasYieldSection: boolean;
  stressSignal: StressSignalEntry | null;
  hasFlows: boolean;
  hasBlacklist: boolean;
};

export type MintAuthorityDetailStatus = "reviewed" | "not-reviewed";

export type MintAuthorityPostureTone = "minimized" | "neutral" | "elevated";

export interface MintAuthorityDetailSourceViewModel {
  label: string;
  url: string;
}

export interface MintAuthorityDetailControlViewModel {
  key: string;
  label: string;
  roleLabel: string;
  authorityTypeLabel: string;
  directMintAbilityLabel: string;
  locationLabel: string;
  addressUrl: string | null;
  securitySetupLabel: string;
  thresholdLabel: string | null;
  timelockLabel: string | null;
  capDescription: string | null;
  modulesOrGuardsLabel: string | null;
  custodyLabel: string | null;
}

export interface MintAuthorityDetailScoreComponentViewModel {
  key: "route" | "controller" | "bounds" | "posture";
  label: string;
  scoreLabel: string;
  weightLabel: string;
  textClassName: string;
}

export interface MintAuthorityDetailIncidentViewModel {
  date: string;
  summary: string;
}

export interface MintAuthorityDetailScoreViewModel {
  score: number | null;
  scoreLabel: string;
  compactLabel: string;
  bandLabel: string;
  badgeClassName: string;
  textClassName: string;
  detail: string;
  components: MintAuthorityDetailScoreComponentViewModel[];
  rawScoreLabel: string | null;
  confidenceCapLabel: string | null;
  weakestControlLabel: string | null;
  weakestControlScoreLabel: string | null;
  weakestControlCustodyLabel: string | null;
  capsApplied: string[];
  unresolvedReasonLabel: string | null;
}

export interface MintAuthorityDetailViewModel {
  status: MintAuthorityDetailStatus;
  reviewLabel: string;
  mintPathLabel: string;
  /** Passport-short projection of the mint path (hero strip width budget). */
  mintPathShortLabel: string;
  authorityPostureLabel: string;
  authorityPostureTone: MintAuthorityPostureTone;
  confidenceLabel: string;
  confidenceVerified: boolean;
  summary: string;
  inheritedFrom: string | null;
  controls: MintAuthorityDetailControlViewModel[];
  sources: MintAuthorityDetailSourceViewModel[];
  score: MintAuthorityDetailScoreViewModel | null;
  reviewedAt: string | null;
  mintIncidents: MintAuthorityDetailIncidentViewModel[];
}

type UnknownRecord = Record<string, unknown>;

export type StablecoinDetailCoinMeta = Omit<StablecoinMeta, "mintAuthority"> & {
  mintAuthoritySummary?: MintAuthorityClientSummary | null;
};

export function buildStablecoinDetailClientCoin(coin: StablecoinMeta): StablecoinDetailCoinMeta {
  const { mintAuthority: _serverOnlyMintAuthority, ...clientCoin } = coin;
  const mintAuthoritySummary = projectMintAuthorityClientSummary(coin);
  return mintAuthoritySummary ? { ...clientCoin, mintAuthoritySummary } : clientCoin;
}

const NOT_REVIEWED_MINT_AUTHORITY: MintAuthorityDetailViewModel = {
  status: "not-reviewed",
  reviewLabel: "Not reviewed by Pharos",
  mintPathLabel: "Unknown",
  mintPathShortLabel: "Unknown",
  authorityPostureLabel: "Unknown",
  authorityPostureTone: "neutral",
  confidenceLabel: "Not reviewed",
  confidenceVerified: false,
  summary:
    "Pharos has not published a mint authority review for this stablecoin yet. Unknown does not mean no privileged mint authority.",
  inheritedFrom: null,
  controls: [],
  sources: [],
  score: null,
  reviewedAt: null,
  mintIncidents: [],
};

const MINT_PATH_LABELS: Record<string, string> = {
  "immutable-user-collateralized": "Immutable user-collateralized",
  "user-collateralized-governed": "User-collateralized, governed",
  "issuer-direct-mint": "Issuer direct mint",
  "permissioned-minter": "Permissioned minter",
  "offchain-attested-minter": "Off-chain attested minter",
  "facilitator-bucket-mint": "Facilitator bucket mint",
  "amo-or-custodian-hybrid": "AMO or custodian hybrid",
  "bridge-or-oft-synthetic": "Bridge or OFT synthetic",
  "m0-permissioned-minter": "M0 permissioned minter",
  "wrapped-or-variant-inherited": "Wrapped or inherited",
  unknown: "Unknown",
};

// Hero passport-strip projection of MINT_PATH_LABELS — authored-short for the
// strip's one-line width budget. The MintAuthoritySection card and the
// passport aria-label keep the full labels.
const MINT_PATH_PASSPORT_LABELS: Record<string, string> = {
  "immutable-user-collateralized": "Immutable CDP",
  "user-collateralized-governed": "Governed CDP",
  "issuer-direct-mint": "Issuer direct",
  "permissioned-minter": "Permissioned",
  "offchain-attested-minter": "Attested minter",
  "facilitator-bucket-mint": "Facilitator",
  "amo-or-custodian-hybrid": "AMO hybrid",
  "bridge-or-oft-synthetic": "Bridge synthetic",
  "m0-permissioned-minter": "M0 minter",
  "wrapped-or-variant-inherited": "Wrapped / inherited",
  unknown: "Unknown",
};

const AUTHORITY_POSTURE_LABELS: Record<string, string> = {
  "none-resolved": "No privileged mint resolved",
  "bounded-admin": "Bounded admin",
  "partially-bounded-admin": "Partially bounded admin",
  "concentrated-admin": "Concentrated admin",
  "unbounded-or-compromised": "Unbounded or compromised",
  unknown: "Unknown",
};

const AUTHORITY_POSTURE_TONES: Record<string, MintAuthorityPostureTone> = {
  "none-resolved": "minimized",
  "bounded-admin": "minimized",
  "partially-bounded-admin": "neutral",
  "concentrated-admin": "elevated",
  "unbounded-or-compromised": "elevated",
  unknown: "neutral",
};

const CONFIDENCE_LABELS: Record<string, string> = {
  verified: "Verified",
  probable: "Probable",
  "manual-review": "Manual review",
  unknown: "Unknown",
};

const CONTROL_ROLE_LABELS: Record<string, string> = {
  "direct-minter": "Direct minter",
  "minter-admin": "Minter admin",
  facilitator: "Facilitator",
  "bucket-admin": "Bucket admin",
  "cap-admin": "Cap admin",
  "proxy-admin": "Proxy admin",
  "bridge-admin": "Bridge admin",
  timelock: "Timelock",
  governor: "Governor",
  "backend-signer": "Backend signer",
  custodian: "Custodian",
  wrapper: "Wrapper",
  other: "Other",
  unknown: "Unknown",
};

const AUTHORITY_TYPE_LABELS: Record<string, string> = {
  safe: "Safe",
  multisig: "Multisig",
  eoa: "Externally owned account",
  timelock: "Timelock",
  "dao-governor": "DAO governor",
  contract: "Contract",
  "issuer-backend": "Issuer backend",
  bridge: "Bridge",
  custodian: "Custodian",
  none: "None",
  unknown: "Unknown",
};

const DIRECT_MINT_ABILITY_LABELS: Record<string, string> = {
  direct: "Direct",
  "cap-limited": "Cap-limited",
  "can-authorize": "Can authorize",
  "upgrade-only": "Upgrade-only",
  "parameter-only": "Parameter-only",
  none: "None",
  unknown: "Unknown",
};

const MODULES_OR_GUARDS_LABELS: Record<string, string> = {
  "none-detected": "No modules or guards detected",
  present: "Modules or guards present",
  unknown: "Modules or guards unknown",
  "not-applicable": "Not applicable",
};

const MODULES_OR_GUARDS_AUTHORITY_TYPES = new Set(["safe", "multisig", "unknown"]);

const MINT_AUTHORITY_SCORE_COMPONENT_KEYS = ["route", "controller", "bounds", "posture"] as const;

const MINT_AUTHORITY_SCORE_COMPONENT_LABELS: Record<
  MintAuthorityDetailScoreComponentViewModel["key"],
  string
> = {
  route: "Route",
  controller: "Controller",
  bounds: "Bounds",
  posture: "Posture",
};

const MINT_AUTHORITY_SCORE_COMPONENT_WEIGHTS: Record<
  MintAuthorityDetailScoreComponentViewModel["key"],
  string
> = {
  route: "30%",
  controller: "40%",
  bounds: "15%",
  posture: "15%",
};

const MINT_AUTHORITY_CAP_LABELS: Record<string, string> = {
  "incident-cap": "Incident cap <= 10",
  "unbounded-cap": "Unbounded cap <= 25",
  "eoa-cap": "EOA cap <= 40",
  "confidence-cap": "Confidence cap",
};

const MINT_AUTHORITY_UNRESOLVED_REASON_LABELS: Record<string, string> = {
  "not-reviewed": "Not reviewed",
  "unknown-mint-path": "Unknown mint path",
  "unknown-posture": "Unknown posture",
  "unknown-confidence": "Unknown confidence",
  "missing-parent": "Missing inherited parent",
  "parent-resolver-missing": "Parent resolver unavailable",
  "inheritance-depth-limit": "Inheritance depth limit",
  "inheritance-cycle": "Inheritance cycle",
  "parent-not-found": "Parent not found",
  "parent-not-scoreable": "Parent not scoreable",
  "unscored-route": "Unscored mint route",
  "unscored-posture": "Unscored posture",
};

const MINT_AUTHORITY_WEAKEST_CUSTODY_LABELS: Record<string, string> = {
  "single-key address - custody unverifiable": "Single-key address - custody unverifiable",
  "single-key address - MPC-attested": "Single-key address - MPC-attested",
  "single-key address - HSM-attested": "Single-key address - HSM-attested",
};

function isEligibleForUsdPerformance(coin: StablecoinMeta): boolean {
  const pegCurrency = coin.flags.pegCurrency;
  return !coin.flags.navToken && pegCurrency !== "USD" && pegCurrency !== "VAR" && pegCurrency !== "OTHER";
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function labelFromMap(value: unknown, labels: Readonly<Record<string, string>>): string {
  const key = stringValue(value);
  if (!key) return "Unknown";
  return (
    labels[key] ??
    key
      .split("-")
      .map((part) => {
        const upper = part.toUpperCase();
        if (["AMO", "DAO", "EOA", "M0", "OFT"].includes(upper)) return upper;
        return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
      })
      .join(" ")
  );
}

function formatThreshold(threshold: number | null, signerCount: number | null): string | null {
  if (threshold == null && signerCount == null) return null;
  if (threshold != null && signerCount != null) return `${threshold}/${signerCount} threshold`;
  if (threshold != null) return `${threshold} threshold`;
  return `${signerCount} signers`;
}

function formatTimelock(seconds: number | null): string | null {
  if (seconds == null || seconds < 0) return null;
  if (seconds === 0) return "No timelock";
  const days = seconds / DAY_SECONDS;
  if (Number.isInteger(days) && days >= 1) return `${days}d timelock`;
  const hours = seconds / 3600;
  if (Number.isInteger(hours) && hours >= 1) return `${hours}h timelock`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m timelock`;
}

function shortenAddress(address: string): string {
  if (address.length <= 18) return address;
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function readSources(value: unknown): MintAuthorityDetailSourceViewModel[] {
  if (!Array.isArray(value)) return [];
  const sources: MintAuthorityDetailSourceViewModel[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (!isRecord(item)) continue;
    const label = stringValue(item.label);
    const url = stringValue(item.url);
    if (!label || !url) continue;
    const key = `${label}:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ label, url });
  }

  return sources;
}

function readMintAuthorityCandidate(coin: StablecoinDetailCoinMeta): UnknownRecord | null {
  const maybeCoin = coin as StablecoinDetailCoinMeta & {
    mintAuthoritySummary?: unknown;
  };
  if (isRecord(maybeCoin.mintAuthoritySummary)) return maybeCoin.mintAuthoritySummary;
  return null;
}

function postureToneFrom(value: unknown): MintAuthorityPostureTone {
  const key = stringValue(value);
  return (key ? AUTHORITY_POSTURE_TONES[key] : undefined) ?? "neutral";
}

function formatModulesOrGuardsLabel(authorityType: unknown, modulesOrGuardsStatus: unknown): string | null {
  const authorityTypeKey = stringValue(authorityType);
  const modulesOrGuardsStatusKey = stringValue(modulesOrGuardsStatus);
  if (!authorityTypeKey || !modulesOrGuardsStatusKey || modulesOrGuardsStatusKey === "not-applicable") return null;
  if (!MODULES_OR_GUARDS_AUTHORITY_TYPES.has(authorityTypeKey)) return null;
  return labelFromMap(modulesOrGuardsStatusKey, MODULES_OR_GUARDS_LABELS);
}

function formatMintAuthorityScoreValue(score: number | null): string {
  return score != null ? `${score}/100` : "NR";
}

function formatMintAuthorityCap(cap: string): string {
  return MINT_AUTHORITY_CAP_LABELS[cap] ?? cap.replaceAll("-", " ");
}

function formatMintAuthorityUnresolvedReason(reason: string | null): string | null {
  if (!reason) return null;
  return MINT_AUTHORITY_UNRESOLVED_REASON_LABELS[reason] ?? reason.replaceAll("-", " ");
}

function formatMintAuthorityCustodyAttestation(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const kind = stringValue(value.kind);
  if (kind === "mpc") return "MPC-attested custody";
  if (kind === "hsm") return "HSM-attested custody";
  return null;
}

function formatMintAuthorityWeakestCustodyLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return MINT_AUTHORITY_WEAKEST_CUSTODY_LABELS[value] ?? value;
}

function readMintIncidents(value: unknown): MintAuthorityDetailIncidentViewModel[] {
  if (!Array.isArray(value)) return [];
  const incidents: MintAuthorityDetailIncidentViewModel[] = [];
  for (const incident of value) {
    if (!isRecord(incident)) continue;
    const date = stringValue(incident.date);
    const summary = stringValue(incident.summary);
    if (date && summary) incidents.push({ date, summary });
  }
  // Newest first: the callout leads with the most recent incident.
  return incidents.sort((a, b) => b.date.localeCompare(a.date));
}

function buildMintAuthorityScoreViewModel(
  display: MintAuthorityScoreDisplay,
): MintAuthorityDetailScoreViewModel {
  const result = display.result;
  const components = MINT_AUTHORITY_SCORE_COMPONENT_KEYS.map((key) => {
    const score = result.components[key];
    return {
      key,
      label: MINT_AUTHORITY_SCORE_COMPONENT_LABELS[key],
      scoreLabel: formatMintAuthorityScoreValue(score),
      weightLabel: MINT_AUTHORITY_SCORE_COMPONENT_WEIGHTS[key],
      textClassName: mintAuthorityScoreTextClassName(score),
    };
  });

  return {
    score: result.score,
    scoreLabel: display.scoreLabel,
    compactLabel: display.compactLabel,
    bandLabel: display.bandLabel,
    badgeClassName: display.badgeClassName,
    textClassName: display.textClassName,
    detail: display.detail,
    components,
    rawScoreLabel: result.rawScore != null ? formatMintAuthorityScoreValue(result.rawScore) : null,
    confidenceCapLabel: result.confidenceCap != null ? `<= ${result.confidenceCap}` : null,
    weakestControlLabel: result.weakestControl?.label ?? null,
    weakestControlScoreLabel: result.weakestControl
      ? formatMintAuthorityScoreValue(result.weakestControl.score)
      : null,
    weakestControlCustodyLabel: formatMintAuthorityWeakestCustodyLabel(result.weakestControl?.custodyLabel),
    capsApplied: result.capsApplied.map(formatMintAuthorityCap),
    unresolvedReasonLabel: formatMintAuthorityUnresolvedReason(result.unresolvedReason),
  };
}

function buildMintAuthorityControlViewModel(
  control: UnknownRecord,
  index: number,
): MintAuthorityDetailControlViewModel | null {
  const label = stringValue(control.label);
  if (!label) return null;
  const chain = stringValue(control.chain);
  const address = stringValue(control.address);
  const safe = isRecord(control.safe) ? control.safe : null;
  const threshold = numberValue(control.threshold) ?? numberValue(safe?.threshold);
  const signerCount = numberValue(control.signerCount) ?? (Array.isArray(safe?.owners) ? safe.owners.length : null);
  const thresholdLabel = formatThreshold(threshold, signerCount);
  const authorityTypeLabel = labelFromMap(control.authorityType, AUTHORITY_TYPE_LABELS);
  const authorityTypeKey = stringValue(control.authorityType);
  const custodyAttestationLabel = formatMintAuthorityCustodyAttestation(control.keyCustodyAttestation);
  const locationLabel =
    [chain, address ? shortenAddress(address) : null].filter(Boolean).join(" / ") || "No address published";
  const addressUrl = address
    ? buildExplorerUrl({ chainKey: chain ?? undefined, entityType: "address", value: address })
    : null;

  return {
    key: `${label}:${chain ?? "no-chain"}:${address ?? index}`,
    label,
    roleLabel: labelFromMap(control.role, CONTROL_ROLE_LABELS),
    authorityTypeLabel,
    directMintAbilityLabel: labelFromMap(control.directMintAbility, DIRECT_MINT_ABILITY_LABELS),
    locationLabel,
    addressUrl,
    securitySetupLabel: thresholdLabel ? `${authorityTypeLabel}, ${thresholdLabel}` : authorityTypeLabel,
    thresholdLabel,
    timelockLabel: formatTimelock(numberValue(control.timelockDelaySec)),
    capDescription: stringValue(control.capDescription),
    modulesOrGuardsLabel: formatModulesOrGuardsLabel(control.authorityType, control.modulesOrGuardsStatus),
    custodyLabel: custodyAttestationLabel
      ? custodyAttestationLabel
      : authorityTypeKey === "eoa"
        ? "Single-key address - custody unverifiable"
        : null,
  };
}

export function buildMintAuthorityDetailViewModel(coin: StablecoinDetailCoinMeta): MintAuthorityDetailViewModel {
  const candidate = readMintAuthorityCandidate(coin);
  if (!candidate) return NOT_REVIEWED_MINT_AUTHORITY;

  const summary = stringValue(candidate.summary);
  if (!summary) return NOT_REVIEWED_MINT_AUTHORITY;

  const review = isRecord(candidate.review) ? candidate.review : null;
  const sources = [...readSources(candidate.sources), ...readSources(review?.sources)];
  const seenSources = new Set<string>();
  const dedupedSources = sources.filter((source) => {
    const key = `${source.label}:${source.url}`;
    if (seenSources.has(key)) return false;
    seenSources.add(key);
    return true;
  });
  const controls = Array.isArray(candidate.controls)
    ? candidate.controls
        .filter(isRecord)
        .map(buildMintAuthorityControlViewModel)
        .filter((control): control is MintAuthorityDetailControlViewModel => control !== null)
    : [];
  const score = buildMintAuthorityScoreViewModel(
    resolveMintAuthorityScoreDisplay(coin.id, coin.mintAuthoritySummary),
  );

  return {
    status: "reviewed",
    reviewLabel: "Reviewed by Pharos",
    mintPathLabel: labelFromMap(candidate.mintPath, MINT_PATH_LABELS),
    mintPathShortLabel: labelFromMap(candidate.mintPath, MINT_PATH_PASSPORT_LABELS),
    authorityPostureLabel: labelFromMap(candidate.authorityPosture, AUTHORITY_POSTURE_LABELS),
    authorityPostureTone: postureToneFrom(candidate.authorityPosture),
    confidenceLabel: labelFromMap(candidate.confidence, CONFIDENCE_LABELS),
    confidenceVerified: stringValue(candidate.confidence) === "verified",
    summary,
    inheritedFrom: stringValue(candidate.inheritedFrom),
    controls,
    sources: dedupedSources,
    score,
    reviewedAt: stringValue(candidate.reviewedAt) ?? stringValue(review?.reviewedAt),
    mintIncidents: readMintIncidents(candidate.mintIncidents),
  };
}

function computePerformanceVsUsd1y(
  coin: StablecoinMeta,
  currentPrice: number | null | undefined,
  supplyHistory: SupplyHistoryPoint[],
  nowMs: number,
): number | null {
  if (!isEligibleForUsdPerformance(coin)) return null;
  if (currentPrice == null || !Number.isFinite(currentPrice) || currentPrice <= 0) return null;

  // The tracked USD price series is the repo-local proxy for non-USD/commodity
  // asset performance without adding an FX-history dependency.
  const pricedHistory = supplyHistory.filter(
    (point) => point.price != null && Number.isFinite(point.price) && point.price > 0,
  );
  if (pricedHistory.length === 0) return null;

  const targetDate = Math.floor(nowMs / 1000) - YEAR_SECONDS;
  if (pricedHistory[0].date > targetDate + YEARLY_PERFORMANCE_ANCHOR_TOLERANCE_SECONDS) {
    return null;
  }

  let anchor = pricedHistory[0];
  let closestDelta = Math.abs(anchor.date - targetDate);

  for (const point of pricedHistory) {
    const delta = Math.abs(point.date - targetDate);
    if (delta < closestDelta) {
      anchor = point;
      closestDelta = delta;
    }
  }

  if (closestDelta > YEARLY_PERFORMANCE_ANCHOR_TOLERANCE_SECONDS || anchor.price == null || anchor.price <= 0) {
    return null;
  }

  return (currentPrice / anchor.price - 1) * 100;
}

function buildMarketSnapshot(
  coin: StablecoinMeta,
  coinData: StablecoinData,
  supplyHistory: SupplyHistoryPoint[],
  nowMs: number,
): MarketSnapshot {
  const mcap = getCirculatingRaw(coinData);
  return {
    mcap,
    supply: deriveSupplyFromMarketCap(mcap, coinData.price),
    prevDay: getPrevDayRawOrNull(coinData),
    prevWeek: getPrevWeekRawOrNull(coinData),
    prevMonth: getPrevMonthRawOrNull(coinData),
    performanceVsUsd1y: computePerformanceVsUsd1y(coin, coinData.price, supplyHistory, nowMs),
    earliestTrackingDate: supplyHistory.length > 0 ? supplyHistory[0].date : null,
  };
}

function buildPegPriceSnapshot(
  id: string,
  coin: StablecoinMeta,
  coinData: StablecoinData,
  listData: StablecoinListResponse,
  pegSummaryData?: PegSummaryResponse,
): PegPriceSnapshot {
  const isNavToken = coin.flags.navToken ?? false;
  const pegContext = derivePegReferenceContext({
    assets: listData.peggedAssets ?? [],
    pegType: coinData.pegType,
    commodityOunces: coin.commodityOunces,
    fallbackRates: listData.fxFallbackRates,
    metaById: CLIENT_TRACKED_META_BY_ID,
  });
  const deviationBps = deriveDeviationBps(coinData.price, pegContext.pegReference);
  const pegScoreResult = pegSummaryData?.coins.find((candidate) => candidate.id === id) ?? null;
  // Worker-side gate (depeg-dews v6.08): thin non-USD peer groups without a
  // live FX fallback produce a self-referential reference, so deviation is
  // withheld and the hero shows "reference unavailable" instead.
  const pegReferenceUnavailable = !isNavToken && pegScoreResult?.pegReferenceUnavailable === true;

  return {
    pegRef: pegContext.pegReference,
    deviationBps,
    gaugeDeviationBps: deriveGaugeDeviationBps(deviationBps, isNavToken),
    pegReferenceUnavailable,
    pegScoreResult,
    consensusSources: pegScoreResult?.consensusSources ?? [],
    agreeSources: pegScoreResult?.agreeSources ?? [],
    dexPriceCheck: pegScoreResult?.dexPriceCheck ?? null,
  };
}

function buildFeatureAvailability(
  id: string,
  coin: StablecoinMeta,
  supplemental: StablecoinDetailViewModelSupplementalInputs,
): FeatureAvailabilitySnapshot {
  const yieldRanking = supplemental.yieldRankingsData?.rankings.find((candidate) => candidate.id === id) ?? null;
  const hasYieldSection = (coin.flags.yieldBearing ?? false) || yieldRanking !== null;
  const stressSignal = supplemental.stressSignalsData?.signals[id] ?? null;
  const hasFlows =
    supplemental.flows.isLoading || !!supplemental.flows.data?.coins.find((entry) => entry.stablecoinId === id);
  const isBlacklistSupported = (BLACKLIST_STABLECOINS as readonly string[]).includes(coin.symbol);
  const hasBlacklist =
    isBlacklistSupported &&
    (supplemental.blacklist.isLoading ||
      (!!supplemental.blacklist.summary &&
        (supplemental.blacklist.summary.stats.perCoinTotalEvents[coin.symbol as BlacklistStablecoin] ?? 0) > 0));

  return {
    yieldRanking,
    hasYieldSection,
    stressSignal,
    hasFlows,
    hasBlacklist,
  };
}

function staleQueryFrom<T>(
  preset: StablecoinDetailStaleQuery["preset"],
  query: DetailQueryResource<T>,
  hasData: (data: T | undefined) => boolean,
): StablecoinDetailStaleQuery {
  return {
    preset,
    dataUpdatedAt: query.dataUpdatedAt,
    error: query.error,
    hasData: hasData(query.data),
    meta: query.meta,
  };
}

function buildStaleQueryInputs(queries: StablecoinDetailViewModelQueryInputs): StablecoinDetailStaleQuery[] {
  return [
    staleQueryFrom("stablecoins", queries.stablecoinList, (data) => !!data?.peggedAssets?.length),
    staleQueryFrom("pegSummary", queries.pegSummary, (data) => !!data?.coins?.length),
    staleQueryFrom("dexLiquidity", queries.dexLiquidity, (data) => !!data),
    staleQueryFrom("reportCards", queries.reportCards, (data) => !!data?.cards?.length),
    staleQueryFrom("redemptionBackstops", queries.redemptionBackstops, (data) => !!data?.coins),
  ];
}

export type StablecoinDetailSummary = StablecoinAiSummary;

interface BaseViewModel {
  handleRetryAll: () => void;
}

interface LoadingViewModel extends BaseViewModel {
  status: "loading";
}

interface ListErrorViewModel extends BaseViewModel {
  status: "list-error";
  listError: unknown;
}

interface NotFoundViewModel extends BaseViewModel {
  status: "not-found";
}

interface StablecoinDetailReadyViewModel extends BaseViewModel {
  status: "ready";
  id: string;
  coin: StablecoinDetailCoinMeta;
  summary: StablecoinDetailSummary | null;
  logoSrc?: string;
  reportCard: ReportCard | undefined;
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
  pegRef: number;
  deviationBps: number;
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
  supplyHistory: SupplyHistoryPoint[];
  earliestTrackingDate: number | null;
  reserves: ReserveResult | null;
  reserveFetchError: unknown | null;
  supplyError: unknown | null;
  staleQueries: StablecoinDetailStaleQuery[];
  verdict: StablecoinVerdict;
  mintAuthority: MintAuthorityDetailViewModel;
}

export interface HeroTertiaryMetricViewModel {
  key: "dews" | "peg-score" | "liquidity" | "excess-yield" | "performance-vs-usd";
  label: "DEWS" | "Peg Score" | "Liquidity" | "30d Excess" | "1Y vs USD";
  mobileLabel?: "Peg" | "Liq";
  methodologyTopic?: "dewsBand" | "pegScore" | "liquidityScore" | "pys";
  display: HeroDisplayValue | HeroDewsDisplay;
  accentClass?: string;
}

export interface HeroSignalRailItemViewModel {
  key: "safety" | "peg" | "liquidity" | "dews";
  label: string;
  primary: string;
  secondary: string | null;
  href: string;
  colorClass: string;
}

export interface HeroCardViewModel {
  coin: StablecoinMeta;
  coinData: StablecoinData;
  logoSrc?: string;
  reportCard: ReportCard | null;
  verdict: StablecoinVerdict;
  variantParent?: StablecoinClientMeta | null;
  variantKind?: VariantKind | null;
  variantChipClass: string | null;
  infrastructures: Infrastructure[];
  header: {
    coinId: string;
    coinName: string;
    compareHref: string;
    benchmarkSymbol: string | null;
  };
  price: {
    pegRef: number;
    deviationBps: number;
    gaugeDeviationBps: number;
    pegReferenceUnavailable: boolean;
    isNavToken: boolean;
    limitedDepegCoverageNote: string | null;
  };
  market: {
    mcap: number;
    supply: number | null;
    safePrevDay: number | null;
    safePrevWeek: number | null;
    hasPrevMonth: boolean;
    safePrevMonth: number | null;
    prevDayTrendClass: string;
    prevWeekTrendClass: string;
    prevMonthTrendClass: string;
  };
  peg: {
    earlyPegScore: boolean;
    trackingSpanDays: number;
    activeDepeg: boolean;
  };
  tertiaryMetrics: HeroTertiaryMetricViewModel[];
  desktopTertiaryMetrics: HeroTertiaryMetricViewModel[];
  signalRailItems: HeroSignalRailItemViewModel[];
  passportItems: HeroPassportItemViewModel[];
}

export type StablecoinDetailViewModel =
  | LoadingViewModel
  | ListErrorViewModel
  | NotFoundViewModel
  | StablecoinDetailReadyViewModel;

interface StablecoinDetailViewModelCoreInputs {
  id: string;
  coin: StablecoinDetailCoinMeta;
  summary: StablecoinDetailSummary | null;
  logoSrc?: string;
  handleRetryAll: () => void;
}

interface BuildStablecoinDetailViewModelParams {
  core: StablecoinDetailViewModelCoreInputs;
  queries: StablecoinDetailViewModelQueryInputs;
  supplemental: StablecoinDetailViewModelSupplementalInputs;
}
export interface BuildHeroCardViewModelParams {
  coin: StablecoinMeta;
  coinData: StablecoinData;
  logoSrc?: string;
  isNavToken: boolean;
  mcap: number;
  supply: number | null;
  prevDay: number | null;
  prevWeek: number | null;
  prevMonth: number | null;
  performanceVsUsd1y: number | null;
  pegRef: number;
  deviationBps: number;
  gaugeDeviationBps: number;
  pegReferenceUnavailable: boolean;
  pegScoreResult: PegSummaryCoin | null;
  liquidityData: DexLiquidityData | undefined;
  yieldRanking: YieldRanking | null;
  stressSignal: StressSignalEntry | null;
  reportCard: ReportCard | null;
  verdict: StablecoinVerdict;
  variantParent?: StablecoinClientMeta | null;
  variantKind?: VariantKind | null;
  resolvedMechanismArchetype: MechanismArchetype | null;
  mintAuthority: MintAuthorityDetailViewModel;
  redemptionBackstop: RedemptionBackstopEntry | null;
}

function getTrendClass(hasPreviousValue: boolean, currentValue: number, previousValue: number): string {
  if (!hasPreviousValue) return HERO_MUTED_CLASS;
  if (isQuietDeviationsEnabled()) {
    if (previousValue <= 0) return HERO_MUTED_CLASS;
    const pctChange = Math.abs((currentValue - previousValue) / previousValue) * 100;
    if (pctChange < 0.5) return HERO_MUTED_CLASS;
    return currentValue >= previousValue ? HERO_POSITIVE_TREND_CLASS : HERO_NEGATIVE_TREND_CLASS;
  }
  return currentValue >= previousValue ? HERO_POSITIVE_TREND_CLASS : HERO_NEGATIVE_TREND_CLASS;
}

export function buildStablecoinDetailHeroViewModel({
  coin,
  coinData,
  logoSrc,
  isNavToken,
  mcap,
  supply,
  prevDay,
  prevWeek,
  prevMonth,
  performanceVsUsd1y,
  pegRef,
  deviationBps,
  gaugeDeviationBps,
  pegReferenceUnavailable,
  pegScoreResult,
  liquidityData,
  yieldRanking,
  stressSignal,
  reportCard,
  verdict,
  variantParent,
  variantKind,
  resolvedMechanismArchetype,
  mintAuthority,
  redemptionBackstop,
}: BuildHeroCardViewModelParams): HeroCardViewModel {
  const recordedDepegEventCount = reportCard?.rawInputs.depegEventCount ?? null;
  const infrastructures: Infrastructure[] = coin.infrastructures ?? [];
  const chainCount = coinData?.chains?.length ?? 0;
  const blacklistStatus = getResolvedBlacklistStatus(coin.id, reportCard);
  const passport = {
    coin,
    chainCount,
    blacklistStatus,
    resolvedMechanismArchetype,
    mintAuthority,
    redemptionBackstop,
    pegScoreResult,
    isNavToken,
  };
  const primaryComparisonPage = getPrimaryStaticComparisonLinkForCoin(coin.id);
  const compareHref = primaryComparisonPage?.href ?? buildLiveCompareUrl([coin.id]);
  const benchmarkSymbol = primaryComparisonPage?.benchmarkSymbol ?? null;

  const hasPrevDay = typeof prevDay === "number" && prevDay > 0;
  const hasPrevWeek = typeof prevWeek === "number" && prevWeek > 0;
  const hasPrevMonth = typeof prevMonth === "number" && prevMonth > 0;
  const safePrevDay = hasPrevDay ? prevDay : null;
  const safePrevWeek = hasPrevWeek ? prevWeek : null;
  const safePrevMonth = hasPrevMonth ? prevMonth : null;
  const prevDayValue = safePrevDay ?? 0;
  const prevWeekValue = safePrevWeek ?? 0;
  const prevMonthValue = safePrevMonth ?? 0;

  const earlyPegScore =
    !isNavToken && pegScoreResult !== null && pegScoreResult.pegScore !== null && pegScoreResult.trackingSpanDays < 30;

  const pegScoreDisplay = buildPegScoreDisplay(isNavToken, pegScoreResult, recordedDepegEventCount);
  const liqDisplay = buildLiquidityDisplay(liquidityData);
  const excessYieldDisplay = buildExcessYieldDisplay(yieldRanking);
  const performanceVsUsdDisplay = buildPerformanceVsUsdDisplay(performanceVsUsd1y);
  const dewsDisplay = buildDewsDisplay(stressSignal);
  const pegScoreAccent = buildPegScoreAccent(pegScoreResult);
  const liqAccent = buildLiquidityAccent(liquidityData);
  const dewsAccent = buildDewsAccent(stressSignal);
  const limitedDepegCoverageNote = buildLimitedDepegCoverageNote(coinData, isNavToken, pegScoreResult, deviationBps);

  const tertiaryMetrics: HeroTertiaryMetricViewModel[] = [
    {
      key: "dews",
      label: "DEWS",
      methodologyTopic: "dewsBand",
      display: dewsDisplay,
      accentClass: dewsAccent,
    },
    {
      key: "peg-score",
      label: "Peg Score",
      mobileLabel: "Peg",
      methodologyTopic: "pegScore",
      display: pegScoreDisplay,
      accentClass: pegScoreAccent,
    },
    {
      key: "liquidity",
      label: "Liquidity",
      mobileLabel: "Liq",
      methodologyTopic: "liquidityScore",
      display: liqDisplay,
      accentClass: liqAccent,
    },
    {
      key: "excess-yield",
      label: "30d Excess",
      methodologyTopic: "pys",
      display: excessYieldDisplay,
    },
    ...(performanceVsUsdDisplay
      ? [
          {
            key: "performance-vs-usd" as const,
            label: "1Y vs USD" as const,
            display: performanceVsUsdDisplay,
          },
        ]
      : []),
  ];

  const passportItems = buildHeroPassportItems(passport);

  const signalRailItems: HeroSignalRailItemViewModel[] = [
    {
      key: "safety",
      label: "Safety",
      primary: reportCard?.overallGrade ?? "—",
      secondary: reportCard?.overallScore != null ? `${reportCard.overallScore}/100` : null,
      href: "#report-card",
      colorClass: reportCard?.overallGrade ? REPORT_CARD_GRADE_COLORS[reportCard.overallGrade] : HERO_MUTED_CLASS,
    },
    {
      key: "peg",
      label: "Peg",
      primary:
        !isNavToken && pegScoreResult?.pegScore != null ? String(pegScoreResult.pegScore) : isNavToken ? "NAV" : "—",
      secondary: null,
      href: "#report-card",
      colorClass:
        !isNavToken && pegScoreResult?.pegScore != null ? pegScoreColor(pegScoreResult.pegScore) : HERO_MUTED_CLASS,
    },
    {
      key: "liquidity",
      label: "Liquidity",
      primary: liquidityData?.liquidityScore != null ? String(Math.round(liquidityData.liquidityScore)) : "—",
      secondary: liquidityData?.poolCount != null ? `${liquidityData.poolCount} pools` : null,
      href: "#liquidity",
      colorClass:
        liquidityData?.liquidityScore != null ? getScoreColor(liquidityData.liquidityScore) : HERO_MUTED_CLASS,
    },
    {
      key: "dews",
      label: "DEWS",
      primary: dewsDisplay.value,
      secondary: dewsDisplay.sub ?? null,
      href: "#report-card",
      colorClass: dewsDisplay.color,
    },
  ];

  return {
    coin,
    coinData,
    logoSrc,
    reportCard,
    verdict,
    variantParent,
    variantKind,
    variantChipClass: variantKind ? getVariantDisplay(variantKind).chipClass : null,
    infrastructures,
    header: {
      coinId: coin.id,
      coinName: coin.name,
      compareHref,
      benchmarkSymbol,
    },
    price: {
      pegRef,
      deviationBps,
      gaugeDeviationBps,
      pegReferenceUnavailable,
      isNavToken,
      limitedDepegCoverageNote,
    },
    market: {
      mcap,
      supply,
      safePrevDay,
      safePrevWeek,
      hasPrevMonth,
      safePrevMonth,
      prevDayTrendClass: getTrendClass(hasPrevDay, mcap, prevDayValue),
      prevWeekTrendClass: getTrendClass(hasPrevWeek, mcap, prevWeekValue),
      prevMonthTrendClass: getTrendClass(hasPrevMonth, mcap, prevMonthValue),
    },
    peg: {
      earlyPegScore,
      trackingSpanDays: pegScoreResult?.trackingSpanDays ?? 0,
      activeDepeg: pegScoreResult?.activeDepeg === true,
    },
    tertiaryMetrics,
    desktopTertiaryMetrics: tertiaryMetrics.filter(
      (metric) => !["dews", "liquidity", "peg-score"].includes(metric.key),
    ),
    signalRailItems,
    passportItems,
  };
}

export function buildStablecoinDetailViewModel({
  core: { id, coin, summary, logoSrc, handleRetryAll },
  queries,
  supplemental,
}: BuildStablecoinDetailViewModelParams): StablecoinDetailViewModel {
  const { supplyHistory, stablecoinList, pegSummary, dexLiquidity, reportCards, redemptionBackstops } = queries;
  const nowMs = supplemental.nowMs ?? Date.now();

  if (supplyHistory.isLoading || stablecoinList.isLoading) {
    return { status: "loading", handleRetryAll };
  }

  if (stablecoinList.isError) {
    return { status: "list-error", listError: stablecoinList.error, handleRetryAll };
  }

  const listData = stablecoinList.data;
  if (!listData) {
    return {
      status: "list-error",
      listError: stablecoinList.error ?? new Error("Stablecoin list data unavailable"),
      handleRetryAll,
    };
  }

  const coinData = listData?.peggedAssets?.find((candidate) => candidate.id === id);
  if (!coinData) {
    return { status: "not-found", handleRetryAll };
  }

  const isNavToken = coin.flags.navToken ?? false;
  const resolvedSupplyHistory = supplyHistory.data ?? [];
  const market = buildMarketSnapshot(coin, coinData, resolvedSupplyHistory, nowMs);
  const pegPrice = buildPegPriceSnapshot(id, coin, coinData, listData, pegSummary.data);
  const liquidityData = dexLiquidity.data?.[id];
  const redemptionBackstop = redemptionBackstops.data?.coins?.[id];
  const reportCard = reportCards.data?.cards.find((candidate) => candidate.id === id);
  const featureAvailability = buildFeatureAvailability(id, coin, supplemental);
  const variantRelationship = getClientVariantRelationship(id);
  const variantParent = getClientVariantParent(id);
  const childVariants = getClientVariants(id);
  const reserves = supplemental.reserves.live ?? getReserves(coin);
  const mintAuthority = buildMintAuthorityDetailViewModel(coin);
  const stressBand =
    featureAvailability.stressSignal && isThreatBand(featureAvailability.stressSignal.band)
      ? featureAvailability.stressSignal.band
      : null;
  const verdict = deriveStablecoinVerdict({
    status: coin.status,
    reportCardGrade: reportCard?.overallGrade ?? null,
    pegScore: pegPrice.pegScoreResult?.pegScore ?? null,
    dewsBand: stressBand,
    mechanismArchetype: coin.mechanismArchetype,
    governance: coin.flags.governance,
    yieldBearing: coin.flags.yieldBearing ?? false,
    activeDepeg: pegPrice.pegScoreResult?.activeDepeg === true,
  });

  return {
    status: "ready",
    handleRetryAll,
    id,
    coin,
    summary,
    logoSrc,
    reportCard,
    reportCardUpdatedAt: reportCards.dataUpdatedAt > 0 ? reportCards.dataUpdatedAt : null,
    variantParent,
    variantSiblings: variantRelationship?.siblings ?? [],
    childVariants,
    isVariant: variantRelationship != null,
    hasVariants: childVariants.length > 0,
    coinData,
    mcap: market.mcap,
    supply: market.supply,
    prevDay: market.prevDay,
    prevWeek: market.prevWeek,
    prevMonth: market.prevMonth,
    performanceVsUsd1y: market.performanceVsUsd1y,
    pegRef: pegPrice.pegRef,
    deviationBps: pegPrice.deviationBps,
    gaugeDeviationBps: pegPrice.gaugeDeviationBps,
    pegReferenceUnavailable: pegPrice.pegReferenceUnavailable,
    isNavToken,
    pegScoreResult: pegPrice.pegScoreResult,
    consensusSources: pegPrice.consensusSources,
    agreeSources: pegPrice.agreeSources,
    dexPriceCheck: pegPrice.dexPriceCheck,
    liquidityData,
    yieldRanking: featureAvailability.yieldRanking,
    hasYieldSection: featureAvailability.hasYieldSection,
    stressSignal: featureAvailability.stressSignal,
    redemptionBackstop,
    hasFlows: featureAvailability.hasFlows,
    hasBlacklist: featureAvailability.hasBlacklist,
    supplyHistory: resolvedSupplyHistory,
    earliestTrackingDate: market.earliestTrackingDate,
    reserves,
    reserveFetchError: supplemental.reserves.error ?? null,
    supplyError: supplyHistory.error,
    staleQueries: buildStaleQueryInputs(queries),
    verdict,
    mintAuthority,
  };
}
