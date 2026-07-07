"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import {
  PegStabilityBody,
  type PegStabilityBodyProps,
} from "@/components/key-info-card/sections";

/**
 * Standalone Peg Stability card for the Risk zone's split first row (Figma
 * coin template): mechanism diagram + explainer link + peg-mechanism prose
 * beside the Key Information card. Owns the #mechanism deep-link anchor when
 * the split renders (Key Info skips its inline copy via splitMechanism).
 */
export function PegStabilityCard(props: PegStabilityBodyProps) {
  if (!props.meta.pegMechanism) return null;

  return (
    <Card id="mechanism" className="h-full rounded-xl scroll-mt-24">
      <CardHeader className="pb-2">
        <DetailSectionTitle>Peg Stability</DetailSectionTitle>
      </CardHeader>
      <CardContent>
        <PegStabilityBody {...props} />
      </CardContent>
    </Card>
  );
}
