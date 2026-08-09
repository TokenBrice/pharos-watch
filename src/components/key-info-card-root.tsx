"use client";

import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import {
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ContractDeployments } from "@/components/key-info-card/contract-deployments";
import {
  ClassificationAndLinks,
  CollateralSection,
  InfrastructureSection,
  LaunchDateSection,
  MechanismSection,
  ProofAndJurisdictionSection,
  getKeyInfoSentenceLabels,
} from "@/components/key-info-card/sections";
import type { MechanismArchetype, StablecoinMeta, VariantKind } from "@shared/types";

export function KeyInfoCard({
  meta,
  resolvedMechanismArchetype,
  isWrapper = false,
  parentSymbol,
  parentArchetype,
  variantKind,
  contractsBelowXlOnly = false,
  splitMechanism = false,
}: {
  meta: StablecoinMeta;
  resolvedMechanismArchetype?: MechanismArchetype | null;
  isWrapper?: boolean;
  parentSymbol?: string | null;
  parentArchetype?: MechanismArchetype | null;
  variantKind?: VariantKind | null;
  /**
   * At xl+ the detail right rail renders its own Contracts card (Figma coin
   * template), so the in-card section CSS-hides there while keeping the
   * `#contracts` deep-link anchor for narrower viewports.
   */
  contractsBelowXlOnly?: boolean;
  /**
   * Figma coin-template split: the sibling PegStabilityCard renders the
   * diagram + peg-mechanism prose (and owns #mechanism), so this card keeps
   * only the collateral half of the mechanism section.
   */
  splitMechanism?: boolean;
}) {
  const { governanceFullLabel, backingFullLabel, pegFullLabel } = getKeyInfoSentenceLabels(meta);

  return (
    <Card className={DETAIL_MODULE_SHELL_CLASS}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>
          Key Information
        </DetailSectionTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-4 py-5 sm:space-y-4 sm:px-5">
        <p className="text-sm leading-relaxed text-muted-foreground">
          {meta.name} ({meta.symbol}) is a {governanceFullLabel}, {backingFullLabel} stablecoin pegged to {pegFullLabel}
          .
        </p>
        <ClassificationAndLinks meta={meta} />
        {splitMechanism ? (
          <CollateralSection meta={meta} />
        ) : (
          <MechanismSection
            meta={meta}
            resolvedMechanismArchetype={resolvedMechanismArchetype}
            isWrapper={isWrapper}
            parentSymbol={parentSymbol}
            parentArchetype={parentArchetype}
            variantKind={variantKind}
          />
        )}
        <InfrastructureSection meta={meta} />
        <ProofAndJurisdictionSection meta={meta} />
        <LaunchDateSection launchDate={meta.launchDate} />
        {contractsBelowXlOnly ? (
          <div className="xl:hidden">
            <ContractDeployments coinId={meta.id} contracts={meta.contracts ?? []} />
          </div>
        ) : (
          <ContractDeployments coinId={meta.id} contracts={meta.contracts ?? []} />
        )}
      </CardContent>
    </Card>
  );
}
