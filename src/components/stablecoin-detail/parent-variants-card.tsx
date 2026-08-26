"use client";

import { useState } from "react";
import Link from "next/link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { ShowAllToggle } from "@/components/stablecoin-detail/disclosure-toggles";
import { logosById } from "@/lib/logos";
import { getVariantDisplay } from "@shared/lib/variant-display";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";

// 6 bordered rows ≈ the dependency graph's height, so the Dependency Context
// split stays balanced even for parents with dozens of variants (USDC).
const PREVIEW_COUNT = 6;

interface ParentVariantsCardProps {
  variants: StablecoinClientMeta[];
}

export function ParentVariantsCard({ variants }: ParentVariantsCardProps) {
  const logos = logosById;
  const [showAll, setShowAll] = useState(false);

  if (variants.length === 0) return null;

  const needsCollapse = variants.length > PREVIEW_COUNT;
  const visible = showAll ? variants : variants.slice(0, PREVIEW_COUNT);

  return (
    <section className="space-y-2.5">
      <h3 className={`px-2.5 ${DETAIL_MODULE_TITLE_CLASS}`}>
        Variants <span className="ml-1 font-normal text-muted-foreground tabular-nums">{variants.length}</span>
      </h3>
      <div className={`grid gap-1.5 ${showAll ? "max-h-96 overflow-y-auto" : ""}`}>
        {visible.map((variant) => {
          const display = variant.variantKind ? getVariantDisplay(variant.variantKind) : null;

          return (
            <Link
              key={variant.id}
              href={buildStablecoinUrl(variant.id)}
              className="pharos-focus-ring flex items-center gap-3 rounded-lg border border-border/50 px-2.5 py-2 transition-colors hover:border-border/80 hover:bg-muted/40"
            >
              <StablecoinLogo src={logos?.[variant.id]} name={variant.name} size={28} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-sm font-semibold text-foreground">{variant.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{variant.symbol}</span>
                </div>
              </div>
              {display ? (
                <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${display.badgeClass}`}>
                  {display.shortLabel}
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>
      {needsCollapse && (
        <ShowAllToggle
          open={showAll}
          onToggle={() => setShowAll((prev) => !prev)}
          total={variants.length}
          noun="variants"
        />
      )}
    </section>
  );
}
