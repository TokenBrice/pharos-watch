import { formatCurrency } from "@shared/lib/format";
import { DEPENDENCY_TYPE_PRESENTATION } from "@/components/contagion-graph-model";
import type { WatershedReadyModel } from "./watershed-stage";

export function WatershedLegend({ model, labelOf }: { model: WatershedReadyModel; labelOf: (id: string) => string }) {
  const { disclosures, widthScale } = model;
  const collateral = DEPENDENCY_TYPE_PRESENTATION.collateral, wrapper = DEPENDENCY_TYPE_PRESENTATION.wrapper;
  return (
    <div className="space-y-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
      <ul className="flex flex-wrap gap-x-5 gap-y-1" aria-label="Watershed legend">
        <li className="flex items-center gap-2" title={collateral.description}>
          <svg width="28" height="8" aria-hidden="true"><rect width="28" height="8" rx="1" fill={collateral.color} fillOpacity="0.42" /></svg>
          {collateral.label} (solid)
        </li>
        <li className="flex items-center gap-2" title={wrapper.description}>
          <svg width="28" height="8" aria-hidden="true">
            <pattern id="ws-legend-wrapper" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill={wrapper.color} fillOpacity="0.3" /><circle cx="2" cy="2" r="0.9" fill={wrapper.color} /></pattern>
            <rect width="28" height="8" rx="1" fill="url(#ws-legend-wrapper)" />
          </svg>
          {wrapper.label} (dotted)
        </li>
        <li className="flex items-center gap-2">
          <svg width="28" height="8" aria-hidden="true"><line x1="0" x2="28" y1="4" y2="4" stroke="currentColor" strokeDasharray="1 3" /></svg>
          Unknown USD ({disclosures.unknownEdgeCount} {disclosures.unknownEdgeCount === 1 ? "link" : "links"})
        </li>
      </ul>
      <p>
        Width = mapped USD (dependent&apos;s supply at evaluation × mapped share), linear. Links under {formatCurrency(widthScale.floorUsd, 0)} draw at the {widthScale.floorPx}px minimum; exact values are in the tooltip and table. Bar height is not supply.
        {" "}A coin&apos;s left side stacks what it maps upstream; its right side stacks its dependents&apos; mapped supply. The two sides measure different things and need not match.
      </p>
      <p>
        Grey stubs (&quot;N folded leaves&quot;) fold dependents that have no tracked dependents of their own.
        {disclosures.multiParentLeafIds.length > 0 && ` ${disclosures.multiParentLeafIds.length} folded coins map to more than one upstream and are counted under each.`}
        {disclosures.doubleSerialDependentIds.length > 0 && ` ${disclosures.doubleSerialDependentIds.map(labelOf).join(", ")} ${disclosures.doubleSerialDependentIds.length === 1 ? "carries" : "carry"} two full claims and ${disclosures.doubleSerialDependentIds.length === 1 ? "is" : "are"} counted under each upstream.`}
        {disclosures.nullSupplyIds.length > 0 && ` ${disclosures.nullSupplyIds.length} linked coins have no published supply at evaluation; their links draw as unknown and are excluded from USD totals.`}
      </p>
    </div>
  );
}
