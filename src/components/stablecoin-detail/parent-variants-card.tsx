"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
    <Card className="rounded-xl border-border/60">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <DetailSectionTitle>Variants</DetailSectionTitle>
          <Badge variant="outline" className="text-[11px]">{variants.length}</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-2">
        {variants.map((variant) => {
          const display = variant.variantKind ? getVariantDisplay(variant.variantKind) : null;

          return (
            <Link
              key={variant.id}
              href={buildStablecoinUrl(variant.id)}
              className="pharos-focus-ring flex items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-3 py-3 transition-colors hover:bg-muted/25"
            >
              <StablecoinLogo src={logos?.[variant.id]} name={variant.name} size={32} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{variant.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{variant.symbol}</span>
                </div>
              </div>
              {display ? (
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${display.badgeClass}`}>
                  {display.shortLabel}
                </span>
              ) : null}
            </Link>
          );
        })}
        <Link
          href={buildHomepageVariantBrowseUrl()}
          className="pharos-focus-ring mt-1 inline-flex w-fit items-center text-xs font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          Browse all tracked variants
        </Link>
      </CardContent>
    </Card>
  );
}
