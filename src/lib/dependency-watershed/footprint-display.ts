import { formatCurrency } from "@shared/lib/format";
import type { ExposureTotals } from "@shared/lib/dependency-exposure";

export function formatFootprintLayer(layer: ExposureTotals): string {
  return layer.hasKnownUsd
    ? `${formatCurrency(layer.knownUsd, 2)}${layer.complete ? "" : " (known supply only)"}`
    : "USD unavailable";
}

export function formatFootprintOverlap(direct: ExposureTotals, indirect: ExposureTotals): string {
  const reason = direct.overlapUnavailableReason ?? indirect.overlapUnavailableReason;
  if (reason === "shared-book-claims-unmatched") return "Overlap bound unavailable (unmatched shared-book claims)";
  if (reason === "serial-parent-attribution-ambiguous") return "Overlap bound unavailable (ambiguous serial parent attribution)";
  if (direct.overlapUpperBoundUsd == null || indirect.overlapUpperBoundUsd == null) return "Overlap bound unavailable";
  const qualified = direct.complete && indirect.complete ? "" : " (known supply only)";
  return `Layer overlap upper bound ${formatCurrency(direct.overlapUpperBoundUsd + indirect.overlapUpperBoundUsd, 2)}${qualified}`;
}
