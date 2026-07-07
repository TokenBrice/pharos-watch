"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { getCoinOverride } from "@/components/stablecoin-detail/mechanism-diagrams/coin-overrides";
import { isThreeStepArchetype } from "@/components/stablecoin-detail/mechanism-diagrams/three-step-archetype-diagram";
import { VerticalThreeStepDiagram } from "@/components/stablecoin-detail/mechanism-diagrams/vertical-three-step-diagram";
import {
  PegStabilityBody,
  type PegStabilityBodyProps,
} from "@/components/key-info-card/sections";
import {
  getMechanismArchetypeCtaNoun,
  getMechanismExplainerPath,
} from "@shared/lib/classification";

/**
 * Standalone Peg Stability card for the Risk zone's split first row (Figma
 * coin template): a VERTICAL numbered mechanism flow with the redeem/return
 * bracket, the explainer link, and the peg-mechanism prose as a mono
 * uppercase footnote pinned at the card bottom. Owns the #mechanism deep-link
 * anchor when the split renders (Key Info skips its inline copy via
 * splitMechanism). Wrapper variants and the synthetic-delta-neutral archetype
 * keep their bespoke horizontal diagrams via PegStabilityBody.
 */
export function PegStabilityCard(props: PegStabilityBodyProps) {
  const { meta, resolvedMechanismArchetype, isWrapper } = props;
  if (!meta.pegMechanism) return null;

  const effectiveArchetype =
    resolvedMechanismArchetype !== undefined ? resolvedMechanismArchetype : (meta.mechanismArchetype ?? null);
  const override = getCoinOverride(meta.id);
  const useVerticalFlow =
    effectiveArchetype != null && !isWrapper && isThreeStepArchetype(effectiveArchetype);

  return (
    <Card id="mechanism" className="h-full gap-0 rounded-xl scroll-mt-24">
      <CardHeader className="pb-2">
        <DetailSectionTitle>Peg Stability</DetailSectionTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {useVerticalFlow ? (
          <>
            <div className="flex flex-1 flex-col items-center justify-center py-3">
              <VerticalThreeStepDiagram
                archetype={effectiveArchetype}
                symbol={meta.symbol}
                steps={override?.steps}
                {...(override?.stressFootnote !== undefined
                  ? { stressFootnote: override.stressFootnote }
                  : {})}
              />
              <Link
                href={getMechanismExplainerPath(effectiveArchetype)}
                className="pharos-focus-ring mt-3 inline-flex items-center gap-1 text-xs font-medium text-frost-blue hover:underline"
              >
                Learn how {getMechanismArchetypeCtaNoun(effectiveArchetype)} stablecoins work
                <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            </div>
            <p className="mt-4 border-t border-border/40 pt-3 font-mono text-[10px] uppercase leading-relaxed tracking-[0.14em] text-muted-foreground">
              {meta.pegMechanism}
            </p>
          </>
        ) : (
          <PegStabilityBody {...props} />
        )}
      </CardContent>
    </Card>
  );
}
