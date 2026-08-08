"use client";

import Link from "next/link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { useLogos } from "@/hooks/use-logos";
import { getVariantAccessibleLabel, getVariantDisplay } from "@shared/lib/variant-display";
import { buildStablecoinUrl } from "@/lib/urls";
import type { StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import type { VariantKind } from "@shared/types";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";

interface UnderlyingAssetCardProps {
  parent: StablecoinClientMeta;
  kind: VariantKind;
  siblings: StablecoinClientMeta[];
}

export function UnderlyingAssetCard({ parent, kind, siblings }: UnderlyingAssetCardProps) {
  const { data: logos } = useLogos();
  const display = getVariantDisplay(kind);

  return (
    <section className="space-y-2.5">
      <h3 className={`px-2.5 ${DETAIL_MODULE_TITLE_CLASS}`}>Underlying Asset</h3>
      <Link
        href={buildStablecoinUrl(parent.id)}
        className="pharos-focus-ring flex items-center gap-3 rounded-lg border border-border/50 px-2.5 py-2.5 transition-colors hover:border-border/80 hover:bg-muted/40"
        aria-label={`View ${parent.name} (${parent.symbol}) details`}
      >
        <StablecoinLogo src={logos?.[parent.id]} name={parent.name} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold text-foreground">{parent.name}</span>
            <span className="font-mono tabular-nums text-xs text-muted-foreground">{parent.symbol}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Modeled as a {getVariantAccessibleLabel(kind).toLowerCase()} of {parent.symbol}.
          </p>
        </div>
        <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${display.chipClass}`}>
          {display.shortLabel}
        </span>
      </Link>
      {siblings.length > 0 ? (
        <p className="px-2.5 text-xs text-muted-foreground">
          Related tracked variants: {siblings.map((sibling) => sibling.symbol).join(", ")}.
        </p>
      ) : null}
    </section>
  );
}
