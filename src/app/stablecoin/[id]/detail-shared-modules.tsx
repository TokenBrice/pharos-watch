"use client";

import type { ReactNode } from "react";
import { BackingMechanicsCard } from "@/components/stablecoin-detail/backing-mechanics-card";
import { BridgingCard } from "@/components/stablecoin-detail/bridging-card";
import { CollateralizationCard } from "@/components/stablecoin-detail/collateralization-card";
import { ControlPostureCard } from "@/components/stablecoin-detail/control-posture-card";
import { CustodyCard } from "@/components/stablecoin-detail/custody-card";
import { FailureDomainsCard } from "@/components/stablecoin-detail/failure-domains-card";
import { FreezeSeizureCard } from "@/components/stablecoin-detail/freeze-seizure-card";
import { RegulatoryStandingCard } from "@/components/stablecoin-detail/regulatory-standing-card";
import type { StablecoinDetailViewModel } from "@/hooks/use-stablecoin-detail-view-model";
import { buildControlPostureView } from "@/lib/control-posture";
import { buildFailureDomainsView } from "@/lib/failure-domains";
import type { MechanismBackingView } from "@/lib/mechanism-backing";
import type { MechanismCollateralizationView } from "@/lib/mechanism-collateralization";
import { buildRegulatoryStandingView } from "@/lib/regulatory-standing";

type ReadyDetailViewModel = Extract<StablecoinDetailViewModel, { status: "ready" }>;

/**
 * The eight detail modules that appear both in the `xl+` summary rail and, on
 * narrower viewports, in the main column — built once here and rendered by both
 * mount sites.
 *
 * Before this module each card was declared twice (rail arm in
 * `detail-content.tsx`, in-flow arm in `detail-risk-context-sections.tsx`) and
 * four of their view builders — `buildRegulatoryStandingView`,
 * `buildControlPostureView`, `buildFailureDomainsView`, and the two live
 * reserve ratios — ran twice per render. Adding a rail card cost two edits in
 * two files; it now costs one entry here.
 *
 * `null` members are modules with nothing to show; every card already renders
 * `null` for empty input, so the rail can mount them unconditionally while the
 * in-flow arm uses the same nullability to decide whether to draw its wrapper.
 */
export interface DetailSharedModules {
  collateralization: ReactNode;
  failureDomains: ReactNode;
  custody: ReactNode;
  backingMechanics: ReactNode;
  bridging: ReactNode;
  regulatoryStanding: ReactNode;
  controlPosture: ReactNode;
  freezeSeizure: ReactNode;
  /** True when the collateralization/failure-domain pair has anything to render. */
  hasStructureCards: boolean;
}

export function buildDetailSharedModules({
  mechanismBacking,
  mechanismCollateralization,
  viewModel,
}: {
  mechanismBacking: MechanismBackingView | null;
  mechanismCollateralization: MechanismCollateralizationView | null;
  viewModel: ReadyDetailViewModel;
}): DetailSharedModules {
  const liveCollateralizationRatio = viewModel.reserves?.metadata?.collateralizationRatio ?? null;
  const liveLiquidationCapacityRatio = viewModel.reserves?.metadata?.liquidationCapacityRatio ?? null;
  const failureDomainsView = buildFailureDomainsView(viewModel.reportCard);
  const regulatoryStanding = buildRegulatoryStandingView(viewModel.coin);
  const controlPosture = buildControlPostureView(viewModel.coin, viewModel.variantParent);
  const custodySummary = viewModel.coin.custodyProfileSummary ?? null;
  const bridgeSummary = viewModel.coin.bridgeRouteRiskSummary ?? null;
  const blacklistabilitySummary = viewModel.coin.blacklistabilitySummary ?? null;

  return {
    collateralization: (
      <CollateralizationCard
        reviewed={mechanismCollateralization}
        liveRatio={liveCollateralizationRatio}
        liveLiquidationCapacityRatio={liveLiquidationCapacityRatio}
        liveAtSec={viewModel.reserves?.liveAt ?? null}
      />
    ),
    failureDomains: <FailureDomainsCard view={failureDomainsView} />,
    custody: custodySummary ? <CustodyCard summary={custodySummary} /> : null,
    backingMechanics: mechanismBacking ? <BackingMechanicsCard view={mechanismBacking} /> : null,
    bridging: bridgeSummary ? <BridgingCard summary={bridgeSummary} /> : null,
    regulatoryStanding: regulatoryStanding ? <RegulatoryStandingCard view={regulatoryStanding} /> : null,
    controlPosture: controlPosture ? <ControlPostureCard view={controlPosture} /> : null,
    freezeSeizure: blacklistabilitySummary ? <FreezeSeizureCard summary={blacklistabilitySummary} /> : null,
    hasStructureCards:
      mechanismCollateralization != null
      || liveCollateralizationRatio != null
      || liveLiquidationCapacityRatio != null
      || failureDomainsView != null,
  };
}
