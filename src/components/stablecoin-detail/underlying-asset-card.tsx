"use client";

import { useContext } from "react";
import Link from "next/link";
import { getVariantAccessibleLabel } from "@shared/lib/variant-display";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import type { VariantKind } from "@shared/types/stablecoin-taxonomy";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";
import { DependencyRow, ListedDependencyIdsContext } from "./collateral-usage-section";

interface UnderlyingAssetCardProps {
  parent: StablecoinClientMeta;
  kind: VariantKind;
  siblings: StablecoinClientMeta[];
}

export function UnderlyingAssetCard({ parent, kind, siblings }: UnderlyingAssetCardProps) {
  const kindLabel = getVariantAccessibleLabel(kind).toLowerCase();
  // The depends-on list beside this card already ranks the parent as a row.
  const parentListed = useContext(ListedDependencyIdsContext).has(parent.id);

  return (
    <section aria-labelledby="underlying-asset-title" className="space-y-2">
      <h3 id="underlying-asset-title" className={DETAIL_MODULE_TITLE_CLASS}>Underlying asset</h3>
      {parentListed ? null : (
        <ul className="-mx-2">
          <DependencyRow
            id={parent.id}
            name={parent.name}
            symbol={parent.symbol}
            detail={parent.name}
            ariaLabel={`View ${parent.name} (${parent.symbol}) details`}
          />
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Modeled as a {kindLabel} of {parent.symbol}.
        {siblings.length > 0 ? (
          <>
            {" "}Other tracked variants:{" "}
            {siblings.map((sibling, index) => (
              <span key={sibling.id}>
                {index > 0 ? ", " : null}
                <Link href={buildStablecoinUrl(sibling.id)} className="pharos-focus-ring rounded-sm text-foreground hover:underline">
                  {sibling.symbol}
                </Link>
              </span>
            ))}
            .
          </>
        ) : null}
      </p>
    </section>
  );
}
