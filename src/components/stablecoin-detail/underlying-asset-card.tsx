"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { useLogos } from "@/hooks/use-logos";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import { getVariantAccessibleLabel, getVariantDisplay } from "@/lib/variant-display";
import { buildHomepageVariantBrowseUrl, buildStablecoinUrl } from "@/lib/urls";
import type { StablecoinMeta, VariantKind } from "@shared/types";

interface UnderlyingAssetCardProps {
  parent: StablecoinMeta;
  kind: VariantKind;
  siblings: StablecoinMeta[];
}

export function UnderlyingAssetCard({ parent, kind, siblings }: UnderlyingAssetCardProps) {
  const { data: logos } = useLogos();
  const display = getVariantDisplay(kind);
  const browseLabel = getVariantAccessibleLabel(kind).replace(/\s+variant$/i, "").toLowerCase();

  return (
    <Card className="rounded-xl border-border/60">
      <CardHeader className="pb-3">
        <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>Underlying Asset</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Link
          href={buildStablecoinUrl(parent.id)}
          className="pharos-focus-ring flex items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-3 py-3 transition-colors hover:bg-muted/25"
          aria-label={`View ${parent.name} (${parent.symbol}) details`}
        >
          <StablecoinLogo src={logos?.[parent.id]} name={parent.name} size={36} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-foreground">{parent.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{parent.symbol}</span>
            </div>
            <p className="text-sm text-muted-foreground">
              This token is modeled as a {getVariantAccessibleLabel(kind).toLowerCase()} of {parent.symbol}.
            </p>
          </div>
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${display.chipClass}`}>
            {display.shortLabel}
          </span>
        </Link>
        {siblings.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Related tracked variants: {siblings.map((sibling) => sibling.symbol).join(", ")}.
          </p>
        ) : null}
        <Link
          href={buildHomepageVariantBrowseUrl(kind)}
          className="pharos-focus-ring inline-flex w-fit items-center text-xs font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          Browse all {browseLabel} variants
        </Link>
      </CardContent>
    </Card>
  );
}
