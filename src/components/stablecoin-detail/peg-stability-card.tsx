"use client";

import Link from "next/link";
import { ArrowUpRight, Info } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
import {
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { cn } from "@/lib/utils";
import { mechanismDiagramFor } from "@/components/stablecoin-detail/mechanism-diagrams";
import { getCoinOverride } from "@/components/stablecoin-detail/mechanism-diagrams/coin-overrides";
import type { MechanismDiagramOptions } from "@/components/stablecoin-detail/mechanism-diagrams/types";
import { isThreeStepArchetype } from "@/components/stablecoin-detail/mechanism-diagrams/three-step-archetype-diagram";
import { VerticalThreeStepDiagram } from "@/components/stablecoin-detail/mechanism-diagrams/vertical-three-step-diagram";
import { getMechanismArchetypeCtaNoun, getMechanismExplainerPath } from "@shared/lib/classification";
import type { MechanismArchetype, StablecoinMeta } from "@shared/types";

export interface PegStabilityCardProps {
  meta: StablecoinMeta;
  resolvedMechanismArchetype?: MechanismArchetype | null;
  isWrapper: boolean;
  parentSymbol?: string | null;
  parentArchetype?: MechanismArchetype | null;
  /**
   * Parent coin's `flags.navToken`, for the wrapper diagram's parent panel.
   * The wrapper's own flag cannot stand in for it (see `MechanismDiagramOptions`).
   */
  parentNavToken?: boolean | null;
  variantKind?: StablecoinMeta["variantKind"] | null;
}

/** Left column: the mechanism flow (vertical numbered steps for the three-step
 *  archetypes, the bespoke horizontal diagrams for wrappers and
 *  synthetic-delta-neutral) plus the explainer CTA. Coins with no archetype get
 *  the custom-design notice in its place. */
function MechanismDiagramColumn({
  meta,
  effectiveArchetype,
  useVerticalFlow,
  diagramOptions,
}: {
  meta: StablecoinMeta;
  effectiveArchetype: MechanismArchetype | null;
  useVerticalFlow: boolean;
  diagramOptions: MechanismDiagramOptions;
}) {
  if (!effectiveArchetype) {
    return (
      <div className="space-y-1.5 rounded-lg border border-border/50 bg-muted/20 px-4 py-3">
        <p className="text-sm font-semibold">Custom design — no archetype assigned</p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          This coin doesn&apos;t fit the tracked archetypes. See the description alongside and the{" "}
          <Link href="/methodology/" className="pharos-focus-ring text-frost-blue hover:underline">
            methodology page
          </Link>{" "}
          for how Pharos scores it.
        </p>
      </div>
    );
  }

  const override = diagramOptions.override;
  return (
    <div className={cn("flex flex-col gap-3", useVerticalFlow ? "items-center" : "items-start")}>
      {useVerticalFlow && isThreeStepArchetype(effectiveArchetype) ? (
        <VerticalThreeStepDiagram
          archetype={effectiveArchetype}
          symbol={meta.symbol}
          steps={override?.steps}
          navToken={diagramOptions.navToken}
          {...(override?.stressFootnote !== undefined ? { stressFootnote: override.stressFootnote } : {})}
        />
      ) : (
        mechanismDiagramFor(effectiveArchetype, meta.symbol, diagramOptions)
      )}
      <Link
        href={getMechanismExplainerPath(effectiveArchetype)}
        className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 py-2 text-xs font-medium text-frost-blue hover:underline sm:min-h-0 sm:py-0"
      >
        Learn how {getMechanismArchetypeCtaNoun(effectiveArchetype)} stablecoins work
        <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
      </Link>
    </div>
  );
}

/**
 * Full-width Peg Stability module: the mechanism flow on the left, the curated
 * backing prose on the right. Owns the `#mechanism` deep-link anchor and, since
 * the Key Information card was retired (its facts all live in the hero passport
 * strip and the rail modules), the only on-page render of `collateral` and
 * `pegMechanism`.
 */
export function PegStabilityCard({
  meta,
  resolvedMechanismArchetype,
  isWrapper,
  parentSymbol,
  parentArchetype,
  parentNavToken,
  variantKind,
}: PegStabilityCardProps) {
  if (!meta.pegMechanism) return null;

  const effectiveArchetype =
    resolvedMechanismArchetype !== undefined ? resolvedMechanismArchetype : (meta.mechanismArchetype ?? null);
  const useVerticalFlow = effectiveArchetype != null && !isWrapper && isThreeStepArchetype(effectiveArchetype);
  // `flags.navToken` splits the tbill archetype's diagram between NAV-accreting
  // fund shares and $1-pegged reserve-backed tokens; the schema defaults the
  // flag, so an absent one is a curated `false` rather than an unknown.
  const diagramOptions: MechanismDiagramOptions = {
    override: getCoinOverride(meta.id),
    navToken: meta.flags?.navToken === true,
    ...(isWrapper && parentArchetype
      ? {
          isWrapper: true,
          parentSymbol: parentSymbol ?? undefined,
          parentArchetype,
          parentNavToken,
          variantKind: variantKind ?? undefined,
        }
      : {}),
  };

  return (
    <Card id="mechanism" className={cn(DETAIL_MODULE_SHELL_CLASS, "scroll-mt-24")}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>
          Peg Stability
        </StablecoinModuleTitle>
        {/* Header info affordance (Figma coin template) → mechanism explainer. */}
        {effectiveArchetype != null ? (
          <Link
            href={getMechanismExplainerPath(effectiveArchetype)}
            aria-label={`Learn how ${getMechanismArchetypeCtaNoun(effectiveArchetype)} stablecoins work`}
            className="pharos-focus-ring flex h-6 w-6 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:text-foreground"
          >
            <Info className="h-3 w-3" aria-hidden="true" />
          </Link>
        ) : null}
      </CardHeader>
      <CardContent className="grid items-start gap-x-8 gap-y-5 px-4 py-5 sm:px-5 lg:grid-cols-2">
        <MechanismDiagramColumn
          meta={meta}
          effectiveArchetype={effectiveArchetype}
          useVerticalFlow={useVerticalFlow}
          diagramOptions={diagramOptions}
        />
        <div className="space-y-4">
          {meta.collateral ? (
            <div>
              <p className="pharos-kicker mb-1.5">Collateral</p>
              <p className="text-base leading-relaxed">{meta.collateral}</p>
            </div>
          ) : null}
          <div>
            <p className="pharos-kicker mb-1.5">Peg Mechanism</p>
            <p className="text-base leading-relaxed">{meta.pegMechanism}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
