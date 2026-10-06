"use client";

import type { ReactNode } from "react";
import { BackingMechanicsCard } from "@/components/stablecoin-detail/backing-mechanics-card";
import { BridgingCard } from "@/components/stablecoin-detail/bridging-card";
import { formatReserveSnapshotLabel } from "@/components/stablecoin-detail/reserve-presentation";
import { buildCollateralizationChip, CollateralizationCard } from "@/components/stablecoin-detail/collateralization-card";
import { ControlPostureCard } from "@/components/stablecoin-detail/control-posture-card";
import { CustodyCard } from "@/components/stablecoin-detail/custody-card";
import { FailureDomainsCard } from "@/components/stablecoin-detail/failure-domains-card";
import { FreezeSeizureCard } from "@/components/stablecoin-detail/freeze-seizure-card";
import { MechanismReviewPanel } from "@/components/stablecoin-detail/mechanism-review-panel";
import type { RailCopyFoldChip } from "@/components/stablecoin-detail/rail-copy-fold";
import { RegulatoryStandingCard } from "@/components/stablecoin-detail/regulatory-standing-card";
import type { StablecoinDetailViewModel } from "@/hooks/use-stablecoin-detail-view-model";
import { buildControlPostureView } from "@/lib/control-posture";
import { buildFailureDomainsView } from "@/lib/failure-domains";
import type { MechanismBackingView } from "@/lib/mechanism-backing";
import type { MechanismCollateralizationView } from "@/lib/mechanism-collateralization";
import type { MechanismReviewView } from "@/lib/mechanism-review";
import { buildRegulatoryStandingView } from "@/lib/regulatory-standing";

type ReadyDetailViewModel = Extract<StablecoinDetailViewModel, { status: "ready" }>;

/**
 * One structural evidence card (custody, bridging, freeze & seizure, …).
 *
 * Each card mounts exactly once, in flow, inside its Safety Score pillar group
 * (`#backing-evidence` / `#control-evidence`), as a `RailCopyFold` band that
 * owns the shell, `title`, `chip` and `anchorId`; `body` is the card's
 * frameless (body-only) render. The `xl+` summary rail only indexes it: one
 * row of `title` + `chip` linking to `anchorId`.
 */
export interface StructuralModuleEntry {
  key: string;
  title: string;
  anchorId: string;
  /** Scan-level verdict chip mirrored from the card's own header badge. */
  chip: RailCopyFoldChip | null;
  body: ReactNode;
}

/**
 * The structural cards grouped by the pillar whose evidence they carry, in
 * reading order. Absent modules (no review published) are omitted, so an
 * empty list means the group has no structural cards to show.
 */
export interface DetailSharedModules {
  backing: StructuralModuleEntry[];
  control: StructuralModuleEntry[];
}

export function buildDetailSharedModules({
  mechanismBacking,
  mechanismCollateralization,
  mechanismReview,
  viewModel,
}: {
  mechanismBacking: MechanismBackingView | null;
  mechanismCollateralization: MechanismCollateralizationView | null;
  mechanismReview: MechanismReviewView | null;
  viewModel: ReadyDetailViewModel;
}): DetailSharedModules {
  const liveCollateralizationRatio = viewModel.reserves?.metadata?.collateralizationRatio ?? null;
  const liveLiquidationCapacityRatio = viewModel.reserves?.metadata?.liquidationCapacityRatio ?? null;
  const liveScopeMetadata = viewModel.reserves?.mode === "live" || viewModel.reserves?.mode === "live-stale"
    ? viewModel.reserves.metadata
    : undefined;
  const failureDomainsView = buildFailureDomainsView(viewModel.reportCard);
  const regulatoryStanding = buildRegulatoryStandingView(viewModel.coin);
  const controlPosture = buildControlPostureView(viewModel.coin, viewModel.variantParent);
  const custodySummary = viewModel.coin.custodyProfileSummary ?? null;
  const bridgeSummary = viewModel.coin.bridgeRouteRiskSummary ?? null;
  const blacklistabilitySummary = viewModel.coin.blacklistabilitySummary ?? null;
  const hasCollateralization =
    mechanismCollateralization != null || liveCollateralizationRatio != null || liveLiquidationCapacityRatio != null;

  const backing: StructuralModuleEntry[] = [];
  if (hasCollateralization) {
    backing.push({
      key: "collateralization",
      title: "Collateralization",
      anchorId: "collateralization",
      chip: buildCollateralizationChip(mechanismCollateralization, liveCollateralizationRatio),
      body: (
        <CollateralizationCard
          reviewed={mechanismCollateralization}
          liveRatio={liveCollateralizationRatio}
          liveLiquidationCapacityRatio={liveLiquidationCapacityRatio}
          liveAtSec={viewModel.reserves?.liveAt ?? null}
          liveFreshnessLabel={viewModel.reserves ? formatReserveSnapshotLabel(viewModel.reserves) : undefined}
          liveBalanceSheetScope={liveScopeMetadata?.balanceSheetScope}
          liveSharedBookAssetIds={liveScopeMetadata?.sharedBookAssetIds}
          frameless
        />
      ),
    });
  }
  if (mechanismBacking) {
    backing.push({
      key: "backingMechanics",
      title: "Backing mechanics",
      anchorId: "backing-mechanics",
      chip: null,
      body: <BackingMechanicsCard view={mechanismBacking} frameless />,
    });
  }
  if (mechanismReview) {
    backing.push({
      key: "mechanismReview",
      title: "Mechanism review",
      anchorId: "mechanism-review",
      chip: null,
      body: <MechanismReviewPanel review={mechanismReview} />,
    });
  }
  if (custodySummary) {
    backing.push({
      key: "custody",
      title: "Custody",
      anchorId: "custody",
      chip: { label: custodySummary.postureLabel, toneClass: custodySummary.postureToneClass },
      body: <CustodyCard summary={custodySummary} frameless />,
    });
  }

  const control: StructuralModuleEntry[] = [];
  if (controlPosture) {
    control.push({
      key: "controlPosture",
      title: "Control posture",
      anchorId: "control-posture",
      chip: { label: controlPosture.label, toneClass: controlPosture.badgeClassName },
      body: <ControlPostureCard view={controlPosture} frameless />,
    });
  }
  if (blacklistabilitySummary) {
    control.push({
      key: "freezeSeizure",
      title: "Freeze & seizure",
      anchorId: "freeze-seizure",
      chip: { label: blacklistabilitySummary.statusLabel, toneClass: blacklistabilitySummary.statusToneClass },
      body: <FreezeSeizureCard summary={blacklistabilitySummary} frameless />,
    });
  }
  if (bridgeSummary) {
    control.push({
      key: "bridging",
      title: "Bridging",
      anchorId: "bridging",
      chip: { label: bridgeSummary.tierLabel, toneClass: bridgeSummary.tierToneClass },
      body: <BridgingCard summary={bridgeSummary} frameless />,
    });
  }
  if (failureDomainsView) {
    control.push({
      key: "failureDomains",
      title: "Shared failure domains",
      anchorId: "failure-domains",
      chip: null,
      body: <FailureDomainsCard view={failureDomainsView} frameless />,
    });
  }
  if (regulatoryStanding) {
    control.push({
      key: "regulatoryStanding",
      title: "Regulatory standing",
      // The passport's Jurisdiction and MiCA cells link here.
      anchorId: "jurisdiction",
      chip: { label: regulatoryStanding.badgeLabel, toneClass: regulatoryStanding.badgeToneClass },
      body: <RegulatoryStandingCard view={regulatoryStanding} frameless />,
    });
  }

  return { backing, control };
}
