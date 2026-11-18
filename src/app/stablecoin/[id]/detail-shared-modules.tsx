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
import { hasMintAuthorityModuleData } from "@/components/stablecoin-detail/mint-authority-section";
import { hasRedemptionRouteModule, isEntryRoute } from "@/components/stablecoin-detail/redemption-backstop-card";
import { formatReserveSnapshotLabel } from "@/components/stablecoin-detail/reserve-presentation";
import type { StablecoinDetailViewModel } from "@/hooks/use-stablecoin-detail-view-model";
import { buildControlPostureView, type ControlPostureView } from "@/lib/control-posture";
import { buildFailureDomainsView, type FailureDomainsView } from "@/lib/failure-domains";
import type { MechanismBackingView } from "@/lib/mechanism-backing";
import type { MechanismCollateralizationView } from "@/lib/mechanism-collateralization";
import type { MechanismReviewView } from "@/lib/mechanism-review";
import { resolveControlComponentRoles, type ControlComponentRoles } from "@/lib/pillar-evidence-strips";
import { buildRegulatoryStandingView, type RegulatoryStandingView } from "@/lib/regulatory-standing";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { shouldDisplayCustodyModule, type CustodyClientSummary } from "@/lib/stablecoin-detail-custody-client";
import {
  buildSafetyScoreV9AccessRows,
  type StablecoinSafetyScoreV9AccessRow,
} from "@/lib/stablecoin-safety-score-v9-presentation";
import { resolveMechanismArchetype, resolveScoreTier5, SCORE_TIER_5_CLASSES } from "@shared/lib/classification";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { findV9NativeMintComponent } from "@shared/lib/safety-score-v9/control-component-keys";

type ReadyDetailViewModel = Extract<StablecoinDetailViewModel, { status: "ready" }>;

export interface EvidenceIndexChip {
  label: string;
  toneClass: string;
}

/**
 * One rail Evidence index row (plan §5, decision S9): a main-column evidence
 * module, its published score or verdict as one chip, and whether it is the
 * Control pillar's limiting input. It links to the module's single in-flow
 * mount. Scores and verdicts share the chip grammar ("75", "79 · not
 * counted", "Segregated"), toned as the module header's own pill.
 */
export interface EvidenceIndexRow {
  key: string;
  title: string;
  anchorId: string;
  chip: EvidenceIndexChip | null;
  /** Eligible Control component at the minimum (plan §6), ties included. */
  limiting: boolean;
}

export interface EvidenceIndexGroup {
  pillar: "backing" | "exit" | "control";
  label: string;
  rows: EvidenceIndexRow[];
}

type RedemptionEvidence =
  | { kind: "route" }
  | { kind: "hidden" }
  | { kind: "placeholder"; label: string; status: ReadyDetailViewModel["featureStates"]["redemption"]["status"] };

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
  /** Passed to the Mechanism card, whose provenance fold owns `#mechanism-review`. */
  mechanismReview: MechanismReviewView | null;
  /** The Backing KPI (plan §7); null mounts no card. */
  backingMetrics: BackingMetricsView | null;
  custody: CustodyClientSummary | null;
  /** The archetype custodies assets but no custody review is published (decision S14). */
  custodyNotReviewed: boolean;
  redemptionEvidence: RedemptionEvidence;
  accessRows: StablecoinSafetyScoreV9AccessRow[];
  hasMintAuthority: boolean;
  /** Null when neither a bridge review nor shared failure domains exist. */
  bridgingForm: BridgingDeploymentsForm | null;
  /**
   * A multi-chain live coin without bridging evidence (decision S14). A
   * single-chain coin has nothing to bridge, so its slot stays empty.
   */
  bridgingNotReviewed: boolean;
  failureDomains: FailureDomainsView | null;
  controlPosture: ControlPostureView | null;
  regulatoryStanding: RegulatoryStandingView | null;
  /** No regulatory review is published for a live coin (decision S14). */
  regulatoryNotReviewed: boolean;
  /** False for a frozen archive or a NAV token: no peg stress layer applies, so DEWS mounts nothing. */
  showDews: boolean;
  evidenceIndex: EvidenceIndexGroup[];
}

const NOT_REVIEWED_CHIP: EvidenceIndexChip = { label: "Not reviewed", toneClass: SEVERITY_TONE_CLASS.neutral.pill };

/** The Control strip's restrained score tint, as on the Price feed header pill. */
const CONTROL_SCORE_TONE_CLASS: Record<ControlComponentRoles["components"][number]["tone"], string> = {
  neutral: SEVERITY_TONE_CLASS.neutral.pill,
  warn: SEVERITY_TONE_CLASS.caution.pill,
  critical: SEVERITY_TONE_CLASS.danger.pill,
};

function formatIndexScore(score: number): string {
  return score > 0 && score < 1 ? "<1" : score.toFixed(0);
}

/**
 * Bridging without a review: a coin on one chain (or native to a chain Pharos
 * does not track, so no contract is stored) has nothing to bridge, which is
 * not a missing review; only a multi-chain coin claims one is missing.
 */
function isMultiChain(viewModel: ReadyDetailViewModel): boolean {
  const contractChains = new Set((viewModel.coin.contracts ?? []).map((contract) => contract.chain));
  const trackedChains = viewModel.coinData.chains?.length ?? 0;
  return contractChains.size > 1 || trackedChains > 1;
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
  if (isEntryRoute(primary, entry)) return entry.score == null ? `counted as ${Math.round(primary.score)}` : null;
  const backup = exit.diversification;
  const backupRoute = backup ? exit.alternatives.find((route) => route.key === backup.routeKey) : null;
  if (backup && backup.bonus > 0 && backupRoute && isEntryRoute(backupRoute, entry)) return "backup";
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
    liveMetadata: liveScopeMetadata,
    oracle: coin.oracleRiskSummary ?? null,
    parent: backingParent,
    distressed: viewModel.coinStates.some((state) => state.kind === "depeg" || state.kind === "critical" || state.kind === "paused"),
  });
  const custody = coin.custodyProfileSummary ?? null;
  const custodyNotReviewed = custody === null && !frozen && needsCustodyReview(coin);
  const redemptionRead = viewModel.featureStates.redemption.status;
  const redemptionEvidence: RedemptionEvidence = hasRedemptionRouteModule(viewModel.redemptionBackstop, coin.id)
    ? { kind: "route" }
    : frozen ? { kind: "hidden" }
      : {
          kind: "placeholder",
          status: redemptionRead,
          label: redemptionRead === "empty" ? "Not reviewed"
            : redemptionRead === "unavailable" ? "Unavailable"
              : redemptionRead === "deferred" ? "Waiting for section" : "Loading",
        };
  const hasMintAuthority = hasMintAuthorityModuleData(viewModel.mintAuthority);
  const failureDomains = buildFailureDomainsView(card);
  const bridgeSummary = coin.bridgeRouteRiskSummary ?? null;
  const bridgingForm = resolveBridgingDeploymentsForm(bridgeSummary, failureDomains);
  const bridgingNotReviewed = bridgingForm === null && !frozen && isMultiChain(viewModel);
  const regulatoryStanding = buildRegulatoryStandingView(coin);
  // A reviewed "no liquidation oracle" is not a module: it mounts nothing.
  const oracleSummary = coin.oracleRiskSummary?.notApplicable ? null : (coin.oracleRiskSummary ?? null);
  const blacklistabilitySummary = coin.blacklistabilitySummary ?? null;
  const roleComponents = controlRoles?.components ?? [];
  const mintComponent = findV9NativeMintComponent(roleComponents);
  const oracleComponent = roleComponents.find((component) => component.kind === "oracle") ?? null;

  const backingRows: EvidenceIndexRow[] = [];
  if (custody || custodyNotReviewed) {
    backingRows.push({
      key: "custody",
      title: "Custody",
      anchorId: "custody",
      chip: custody ? { label: custody.postureLabel, toneClass: custody.postureToneClass } : NOT_REVIEWED_CHIP,
      limiting: false,
    });
  }

  const exitRows: EvidenceIndexRow[] = [];
  if (redemptionEvidence.kind !== "hidden") {
    const entry = viewModel.redemptionBackstop ?? null;
    const score = entry?.score ?? null;
    const exitNote = entry ? resolveRedemptionExitNote(card, entry) : null;
    const scoreTier = resolveScoreTier5(score);
    exitRows.push({
      key: "redemption",
      title: "Redemption route",
      anchorId: "redemption",
      // The route score toned as the module's header pill, with how Exit
      // treats it; an unrated route reads "NR", never a blank row.
      chip: entry
        ? {
            label: `${score === null ? "NR" : formatIndexScore(score)}${exitNote ? ` · ${exitNote}` : ""}`,
            toneClass: scoreTier === null ? SEVERITY_TONE_CLASS.neutral.pill : SCORE_TIER_5_CLASSES[scoreTier].pill,
          }
        : redemptionEvidence.kind === "route"
          ? { label: "No holder route", toneClass: SEVERITY_TONE_CLASS.neutral.pill }
          : { label: redemptionEvidence.label, toneClass: SEVERITY_TONE_CLASS.neutral.pill },
      limiting: false,
    });
  }

  const controlRows: EvidenceIndexRow[] = [
    {
      key: "mintAuthority",
      title: "Mint Authority",
      anchorId: "mint-authority",
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
      chip: oracleComponent && oracleScore !== null
        ? { label: formatIndexScore(oracleScore), toneClass: CONTROL_SCORE_TONE_CLASS[oracleComponent.tone] }
        : { label: oracleSummary.tierLabel, toneClass: oracleSummary.tierToneClass },
      limiting: oracleComponent?.role === "limiting",
    });
  }
  if (bridgingForm !== null || bridgingNotReviewed) {
    controlRows.push({
      key: "bridging",
      title: "Bridging & deployments",
      anchorId: "bridging",
      chip: bridgingForm !== null
        ? buildBridgingDeploymentsIndexChip(bridgeSummary, failureDomains, controlRoles)
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
    mechanismReview,
    backingMetrics,
    custody,
    custodyNotReviewed,
    redemptionEvidence,
    accessRows: card ? buildSafetyScoreV9AccessRows(card) : [],
    hasMintAuthority,
    bridgingForm,
    bridgingNotReviewed,
    failureDomains,
    controlPosture: buildControlPostureView(coin, viewModel.variantParent),
    regulatoryStanding,
    // A curated profile that resolves to no reader-facing regime (a reviewed
    // out-of-scope GENIUS record) is not "not reviewed".
    regulatoryNotReviewed: regulatoryStanding === null && !coin.genius && !coin.mica && !frozen,
    showDews: !frozen && !viewModel.isNavToken,
    evidenceIndex,
  };
}
