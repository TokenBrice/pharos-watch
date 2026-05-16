"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { useLogos } from "@/hooks/use-logos";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { getVariantDisplay } from "@/lib/variant-display";
import { buildHomepageVariantBrowseUrl, buildStablecoinUrl } from "@/lib/urls";
import type { StablecoinMeta } from "@shared/types";

interface ParentVariantsCardProps {
  variants: StablecoinMeta[];
}

export function ParentVariantsCard({ variants }: ParentVariantsCardProps) {
  const { data: logos } = useLogos();

  if (variants.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <DetailSectionTitle>Variants</DetailSectionTitle>
        <Badge variant="outline" className="text-[11px]">{variants.length}</Badge>
      </div>
      <div className="grid gap-1.5">
        {variants.map((variant) => {
          const display = variant.variantKind ? getVariantDisplay(variant.variantKind) : null;

          return (
            <Link
              key={variant.id}
              href={buildStablecoinUrl(variant.id)}
              className="pharos-focus-ring flex items-center gap-3 rounded-lg border border-border/50 px-3 py-2 transition-colors hover:border-border/80 hover:bg-muted/30"
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
      <Link
        href={buildHomepageVariantBrowseUrl()}
        className="pharos-focus-ring inline-flex w-fit items-center text-xs font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
      >
        Browse all tracked variants
      </Link>
    </section>
  );
}
