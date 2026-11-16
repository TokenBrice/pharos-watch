"use client";

import { useContext, useState } from "react";
import { ShowAllToggle } from "@/components/stablecoin-detail/disclosure-toggles";
import type { StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";
import { DependencyRow, ListedDependencyIdsContext, variantKindLabel } from "./collateral-usage-section";

// Matches the Used-by preview so the two Dependency context columns stay
// balanced even for parents with dozens of variants (USDC).
const PREVIEW_COUNT = 8;

interface ParentVariantsCardProps {
  variants: StablecoinClientMeta[];
}

/**
 * The parent's tracked variants that "Used by" does not already rank: a
 * variant with a published dependency link reads there, with its exposure and
 * kind. When some moved, the heading says "Other variants"; when all did, the
 * card renders nothing.
 */
export function ParentVariantsCard({ variants }: ParentVariantsCardProps) {
  const [showAll, setShowAll] = useState(false);
  const rankedIds = useContext(ListedDependencyIdsContext);
  const listed = variants.filter((variant) => !rankedIds.has(variant.id));

  if (listed.length === 0) return null;

  const visible = showAll ? listed : listed.slice(0, PREVIEW_COUNT);

  return (
    <section aria-labelledby="parent-variants-title" className="space-y-2">
      <h3 id="parent-variants-title" className={DETAIL_MODULE_TITLE_CLASS}>
        {listed.length < variants.length ? "Other variants" : "Variants"}{" "}
        <span className="ml-1 font-mono font-normal tabular-nums">{listed.length}</span>
      </h3>
      <ul className={showAll && listed.length > PREVIEW_COUNT ? "-mx-2 max-h-[30rem] space-y-0.5 overflow-y-auto" : "-mx-2 space-y-0.5"}>
        {visible.map((variant) => {
          const kind = variant.variantKind ? variantKindLabel(variant.variantKind) : null;
          return (
            <DependencyRow
              key={variant.id}
              id={variant.id}
              name={variant.name}
              symbol={variant.symbol}
              detail={kind ? `${kind} · ${variant.name}` : variant.name}
              ariaLabel={`${variant.name} (${variant.symbol})${kind ? `, ${kind.toLowerCase()} variant` : ""}`}
            />
          );
        })}
      </ul>
      {listed.length > PREVIEW_COUNT ? (
        <ShowAllToggle
          open={showAll}
          onToggle={() => setShowAll((prev) => !prev)}
          total={listed.length}
          noun="variants"
          className="-ml-2.5"
        />
      ) : null}
    </section>
  );
}
