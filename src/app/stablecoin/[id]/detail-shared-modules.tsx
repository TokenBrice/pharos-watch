"use client";

import {
  buildBackingMetricsView,
  resolveLiveRatioBasis,
  type BackingMetricsInput,
  type BackingMetricsView,
} from "@/components/stablecoin-detail/backing-metrics-card";
import {
  buildBridgingDeploymentsIndexChip,
  resolveBridgingDeploymentsForm,
  type BridgingDeploymentsForm,
} from "@/components/stablecoin-detail/bridging-card";
import type { EvidenceState } from "@/components/stablecoin-detail/evidence-module";
import { hasMintAuthorityModuleData } from "@/components/stablecoin-detail/mint-authority-section";
import { hasRedemptionRouteModule, isEntryRouteKey } from "@/components/stablecoin-detail/redemption-backstop-card";
import { formatReserveSnapshotLabel } from "@/components/stablecoin-detail/reserve-presentation";
import type { StablecoinDetailViewModel } from "@/hooks/use-stablecoin-detail-view-model";
import { buildControlPostureView, type ControlPostureView } from "@/lib/control-posture";
import { buildFailureDomainsView, type FailureDomainsView } from "@/lib/failure-domains";
import type { MechanismBackingView } from "@/lib/mechanism-backing";
import type { MechanismCollateralizationView } from "@/lib/mechanism-collateralization";
import type { MechanismReviewView } from "@/lib/mechanism-review";
import {
  buildPillarEvidenceStrips,
  resolveControlComponentRoles,
  type ControlComponentRoles,
  type PillarEvidenceStrips,
} from "@/lib/pillar-evidence-strips";
import { buildRegulatoryStandingView, type RegulatoryStandingView } from "@/lib/regulatory-standing";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { shouldDisplayCustodyModule, type CustodyClientSummary } from "@/lib/stablecoin-detail-custody-client";
import {
  buildSafetyScoreV9AccessRows,
  type StablecoinSafetyScoreV9AccessRow,
} from "@/lib/stablecoin-safety-score-v9-presentation";
import { BRIDGE_TIER_LABELS, resolveMechanismArchetype } from "@shared/lib/classification";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";

type ReadyDetailViewModel = Extract<StablecoinDetailViewModel, { status: "ready" }>;

export interface EvidenceIndexChip {
  label: string;
  toneClass: string;
}

/**
 * One rail Evidence index row (plan §5, decision S9): a main-column evidence
 * module, its published score or verdict chip, and whether it is the Control
 * pillar's limiting input. It links to the module's single in-flow mount.
 */
export interface EvidenceIndexRow {
  key: string;
  title: string;
  anchorId: string;
  /** Published score the module's header pill carries; null when it carries a chip instead. */
  score: number | null;
  /**
   * How the score enters its pillar when it does not set it directly, e.g. a
   * redemption route the Exit pillar does not count ("79 · not counted").
   */
  scoreNote: string | null;
  chip: EvidenceIndexChip | null;
  /** Eligible Control component at the minimum (plan §6), ties included. */
  limiting: boolean;
}

export interface EvidenceIndexGroup {
  pillar: "backing" | "exit" | "control";
  label: string;
  rows: EvidenceIndexRow[];
}

/**
 * The explicit one-line state (decision S14) a module renders in its usual
 * slot when the coin lacks it: "Not reviewed", or "Not applicable" with a
 * reason. Frozen coins keep their reduced dossier and get none of these.
 */
export interface EvidencePlaceholder {
  state: EvidenceState;
  reason?: string;
}

/**
 * Everything the Risk zone and the `xl+` summary rail both read, built once
 * per render so the pillar boards and the rail index can never disagree about
 * which modules exist.
 *
 * Every evidence module mounts exactly once, in flow, inside its Safety Score
 * pillar board (`#backing-evidence` / `#exit-evidence` / `#control-evidence`).
 * The rail carries metric cards (Backing KPI, Access posture, Regulatory
 * standing) whose in-flow `xl:hidden` twins own the anchors, and an Evidence
 * index row per module.
 */
export interface DetailSharedModules {
  /** `resolveControlComponentRoles(card)`, shared by Mint, Price feed and Bridging. */
  controlRoles: ControlComponentRoles | null;
  strips: PillarEvidenceStrips;
  mechanismReview: MechanismReviewView | null;
  /** The Backing KPI (plan §7); null mounts no card. */
  backingMetrics: BackingMetricsView | null;
  custody: CustodyClientSummary | null;
  /** The archetype custodies assets but no custody review is published (decision S14). */
  custodyNotReviewed: boolean;
  hasRedemption: boolean;
  /** No redemption route module and no reviewed no-holder disposition (decision S14). */
  redemptionNotReviewed: boolean;
  accessRows: StablecoinSafetyScoreV9AccessRow[];
  hasMintAuthority: boolean;
  /** Null when neither a bridge review nor shared failure domains exist. */
  bridgingForm: BridgingDeploymentsForm | null;
  /** The Bridging slot's S14 line when `bridgingForm` is null; null renders nothing. */
  bridgingPlaceholder: EvidencePlaceholder | null;
  failureDomains: FailureDomainsView | null;
  controlPosture: ControlPostureView | null;
  regulatoryStanding: RegulatoryStandingView | null;
  /** No regulatory review is published for a live coin (decision S14). */
  regulatoryNotReviewed: boolean;
  /** The DEWS slot's S14 line (frozen archive, NAV token); null mounts the live module. */
  dewsPlaceholder: EvidencePlaceholder | null;
  evidenceIndex: EvidenceIndexGroup[];
}

const NOT_REVIEWED_CHIP: EvidenceIndexChip = { label: "Not reviewed", toneClass: SEVERITY_TONE_CLASS.neutral.pill };
const NOT_SCORED_CHIP: EvidenceIndexChip = { label: "Not scored", toneClass: SEVERITY_TONE_CLASS.neutral.pill };

const SINGLE_CHAIN_LABEL = BRIDGE_TIER_LABELS["single-chain-or-native"];

/**
 * Bridging without a review: a coin on one chain (or native to a chain Pharos
 * does not track, so no contract is stored) has nothing to bridge, which is
 * "not applicable", not a missing review. Spec §5: single-chain coins read
 * "Single-chain / native".
 */
function resolveBridgingPlaceholder(viewModel: ReadyDetailViewModel): EvidencePlaceholder {
  const contractChains = new Set((viewModel.coin.contracts ?? []).map((contract) => contract.chain));
  const trackedChains = viewModel.coinData.chains?.length ?? 0;
  return contractChains.size <= 1 && trackedChains <= 1
    ? { state: "not-applicable", reason: SINGLE_CHAIN_LABEL }
    : { state: "not-reviewed" };
}

/**
 * The custody "Not reviewed" line is for mechanisms that centrally custody
 * assets. `shouldDisplayCustodyModule` lets a curated `custodyModel` override
 * the archetype so a published custody review always shows; a placeholder
 * claims a review is missing, so it also needs a custodial archetype (a CDP
 * such as ZCHF holds collateral on-chain, whatever its collateral tokens).
 */
function needsCustodyReview(coin: ReadyDetailViewModel["coin"]): boolean {
  const archetype = resolveMechanismArchetype(coin, CLIENT_TRACKED_META_BY_ID);
  return shouldDisplayCustodyModule(coin, archetype) && archetype !== "cdp" && archetype !== "algorithmic";
}

/**
 * How the reviewed redemption route enters the Exit pillar (plan §6, §10 #8),
 * read from the same `primaryRoute` join as the Redemption module's
 * reconciliation sentence: null when Exit scores this rated route, "counted as
 * N" when Exit scores this route but its standalone score is not rated,
 * "backup" when it earns the diversification credit, "not selected" when Exit
 * uses a better route, "not counted" when no route qualifies at the requested
 * notional.
 */
function resolveRedemptionExitNote(
  card: ReadyDetailViewModel["reportCard"] | null,
  entry: NonNullable<ReadyDetailViewModel["redemptionBackstop"]>,
): string | null {
  const exit = card?.breakdowns?.exit ?? null;
  if (!exit) return null;
  const primary = exit.primaryRoute;
  if (primary === null || primary.score === null) return "not counted";
  if (isEntryRouteKey(primary.key, entry)) return entry.score == null ? `counted as ${Math.round(primary.score)}` : null;
  const backup = exit.diversification;
  if (backup && backup.bonus > 0 && isEntryRouteKey(backup.routeKey, entry)) return "backup";
  return "not selected";
}

export function buildDetailSharedModules({
  mechanismBacking,
  backingParent,
  mechanismCollateralization,
  mechanismReview,
  viewModel,
}: {
  mechanismBacking: MechanismBackingView | null;
  /** A pure or savings pass-through wrapper's parent: the Backing KPI reads "via <parent>". */
  backingParent: NonNullable<BackingMetricsInput["parent"]> | null;
  mechanismCollateralization: MechanismCollateralizationView | null;
  mechanismReview: MechanismReviewView | null;
  viewModel: ReadyDetailViewModel;
}): DetailSharedModules {
  const { coin, reportCard } = viewModel;
  const card = reportCard ?? null;
  const frozen = coin.status === "frozen";
  const controlRoles = card ? resolveControlComponentRoles(card) : null;
  const strips = buildPillarEvidenceStrips(card, { frozen, bridging: coin.bridgeRouteRiskSummary ?? null });
  const liveScopeMetadata = viewModel.reserves?.mode === "live" || viewModel.reserves?.mode === "live-stale"
    ? viewModel.reserves.metadata
    : undefined;
  const backingMetrics = buildBackingMetricsView({
    collateralization: mechanismCollateralization,
    backing: mechanismBacking,
    liveRatio: viewModel.reserves?.metadata?.collateralizationRatio ?? null,
    liveLiquidationCapacityRatio: viewModel.reserves?.metadata?.liquidationCapacityRatio ?? null,
    liveAtSec: viewModel.reserves?.liveAt ?? null,
    liveFreshnessLabel: viewModel.reserves ? formatReserveSnapshotLabel(viewModel.reserves) : undefined,
    liveBalanceSheetScope: liveScopeMetadata?.balanceSheetScope,
    liveSharedBookAssetIds: liveScopeMetadata?.sharedBookAssetIds,
    liveRatioBasis: resolveLiveRatioBasis(viewModel.reserves?.metadata),
    liveStale: viewModel.reserves?.mode === "live-stale",
    oracle: coin.oracleRiskSummary ?? null,
    parent: backingParent,
  });
  const custody = coin.custodyProfileSummary ?? null;
  const custodyNotReviewed = custody === null && !frozen && needsCustodyReview(coin);
  const hasRedemption = hasRedemptionRouteModule(viewModel.redemptionBackstop, coin.id);
  const redemptionNotReviewed = !hasRedemption && !frozen;
  const hasMintAuthority = hasMintAuthorityModuleData(viewModel.mintAuthority);
  const failureDomains = buildFailureDomainsView(card);
  const bridgeSummary = coin.bridgeRouteRiskSummary ?? null;
  const bridgingForm = resolveBridgingDeploymentsForm(bridgeSummary, failureDomains);
  const bridgingPlaceholder = bridgingForm === null && !frozen ? resolveBridgingPlaceholder(viewModel) : null;
  const regulatoryStanding = buildRegulatoryStandingView(coin);
  const dewsPlaceholder: EvidencePlaceholder | null = frozen
    ? { state: "not-applicable", reason: "frozen archive" }
    : viewModel.isNavToken
      ? { state: "not-applicable", reason: "NAV tokens are priced by NAV, not peg" }
      : null;
  const oracleSummary = coin.oracleRiskSummary ?? null;
  const blacklistabilitySummary = coin.blacklistabilitySummary ?? null;
  const roleComponents = controlRoles?.components ?? [];
  const mintComponent = roleComponents.find((component) => component.kind === "mint") ?? null;
  const oracleComponent = roleComponents.find((component) => component.kind === "oracle") ?? null;

  const backingRows: EvidenceIndexRow[] = [];
  if (custody || custodyNotReviewed) {
    backingRows.push({
      key: "custody",
      title: "Custody",
      anchorId: "custody",
      score: null,
      scoreNote: null,
      chip: custody ? { label: custody.postureLabel, toneClass: custody.postureToneClass } : NOT_REVIEWED_CHIP,
      limiting: false,
    });
  }
  // The provenance row renders under the Backing kicker with or without a card;
  // without a published mechanism group score it says so rather than going blank.
  if (mechanismReview) {
    const mechanismScore = strips.backing?.groups.find((group) => group.key === "mechanism")?.score ?? null;
    backingRows.push({
      key: "mechanismReview",
      title: "Mechanism review",
      anchorId: "mechanism-review",
      score: mechanismScore,
      scoreNote: null,
      chip: mechanismScore === null ? NOT_SCORED_CHIP : null,
      limiting: false,
    });
  }

  const exitRows: EvidenceIndexRow[] = [];
  if (hasRedemption || redemptionNotReviewed) {
    const entry = viewModel.redemptionBackstop ?? null;
    const score = entry?.score ?? null;
    const exitNote = entry ? resolveRedemptionExitNote(card, entry) : null;
    exitRows.push({
      key: "redemption",
      title: "Redemption route",
      anchorId: "redemption",
      score,
      scoreNote: score !== null ? exitNote : null,
      // An unrated route reads "NR", with how Exit treats it, never a blank row.
      chip: entry
        ? score === null
          ? { label: exitNote ? `NR · ${exitNote}` : "NR", toneClass: SEVERITY_TONE_CLASS.neutral.pill }
          : null
        : hasRedemption
          ? { label: "No holder route", toneClass: SEVERITY_TONE_CLASS.neutral.pill }
          : NOT_REVIEWED_CHIP,
      limiting: false,
    });
  }

  const controlRows: EvidenceIndexRow[] = [
    {
      key: "mintAuthority",
      title: "Mint Authority",
      anchorId: "mint-authority",
      score: null,
      scoreNote: null,
      chip: !hasMintAuthority
        ? NOT_REVIEWED_CHIP
        : viewModel.mintAuthority.score
          ? { label: viewModel.mintAuthority.score.compactLabel, toneClass: viewModel.mintAuthority.score.badgeClassName }
          : null,
      limiting: hasMintAuthority && mintComponent?.role === "limiting",
    },
  ];
  if (oracleSummary) {
    const oracleScore = oracleComponent?.score ?? null;
    controlRows.push({
      key: "oracle",
      title: oracleSummary.title,
      anchorId: "oracle",
      score: oracleScore,
      scoreNote: null,
      chip: oracleScore === null ? { label: oracleSummary.tierLabel, toneClass: oracleSummary.tierToneClass } : null,
      limiting: oracleComponent?.role === "limiting",
    });
  }
  if (bridgingForm !== null || bridgingPlaceholder !== null) {
    controlRows.push({
      key: "bridging",
      title: "Bridging & deployments",
      anchorId: "bridging",
      score: null,
      scoreNote: null,
      chip: bridgingForm !== null
        ? buildBridgingDeploymentsIndexChip(bridgeSummary, failureDomains, controlRoles)
        : bridgingPlaceholder?.state === "not-applicable"
          ? { label: SINGLE_CHAIN_LABEL, toneClass: SEVERITY_TONE_CLASS.neutral.pill }
          : NOT_REVIEWED_CHIP,
      limiting: bridgingForm !== null
        && roleComponents.some((component) => component.kind === "bridge" && component.role === "limiting"),
    });
  }
  if (blacklistabilitySummary) {
    controlRows.push({
      key: "freezeSeizure",
      title: "Freeze & seizure",
      anchorId: "freeze-seizure",
      score: null,
      scoreNote: null,
      chip: { label: blacklistabilitySummary.statusLabel, toneClass: blacklistabilitySummary.statusToneClass },
      limiting: false,
    });
  }

  const evidenceIndex: EvidenceIndexGroup[] = [
    { pillar: "backing" as const, label: "Backing", rows: backingRows },
    { pillar: "exit" as const, label: "Exit", rows: exitRows },
    { pillar: "control" as const, label: "Control", rows: controlRows },
  ].filter((group) => group.rows.length > 0);

  return {
    controlRoles,
    strips,
    mechanismReview,
    backingMetrics,
    custody,
    custodyNotReviewed,
    hasRedemption,
    redemptionNotReviewed,
    accessRows: card ? buildSafetyScoreV9AccessRows(card) : [],
    hasMintAuthority,
    bridgingForm,
    bridgingPlaceholder,
    failureDomains,
    controlPosture: buildControlPostureView(coin, viewModel.variantParent),
    regulatoryStanding,
    regulatoryNotReviewed: regulatoryStanding === null && !frozen,
    dewsPlaceholder,
    evidenceIndex,
  };
}
