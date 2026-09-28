import { cn } from "@/lib/utils";
import type { MintBurnValuationCompleteness } from "@shared/types";
import {
  describeMintBurnVolumeBound,
  formatMintBurnVolume,
  type MintBurnSignedNetView,
} from "@/lib/mint-burn-valuation-display";

/**
 * Signed mint/burn net with valuation-completeness semantics: an unavailable net
 * (null, or partial valuation) renders the placeholder with an accessible reason,
 * never $0; a coverage-unknown net keeps its value with a subtle marker.
 */
export function FlowSignedNetValue({
  net,
  format,
  colorClassName,
  className,
  placeholder = "—",
}: {
  net: MintBurnSignedNetView;
  format: (valueUsd: number) => string;
  /** Color class for an available value, e.g. `getNetColor`. */
  colorClassName?: (valueUsd: number) => string;
  className?: string;
  placeholder?: string;
}) {
  if (net.valueUsd == null) {
    return (
      <span className={cn("text-muted-foreground", className)} title={net.note ?? undefined}>
        <span aria-hidden="true">{placeholder}</span>
        <span className="sr-only">{net.note ?? "Unavailable"}</span>
      </span>
    );
  }
  return (
    <span className={cn(colorClassName?.(net.valueUsd), className)} title={net.note ?? undefined}>
      {format(net.valueUsd)}
      {net.completeness === "unknown" ? (
        <>
          <span aria-hidden="true" className="ml-0.5 align-super text-[0.65em] text-muted-foreground">*</span>
          <span className="sr-only"> (coverage unknown)</span>
        </>
      ) : null}
    </span>
  );
}

/** Gross mint or burn volume; a non-complete side renders as a `≥` lower bound with its reason. */
export function FlowVolumeValue({
  valueUsd,
  completeness,
  unpricedEventCount,
  format,
  className,
}: {
  valueUsd: number;
  completeness: MintBurnValuationCompleteness | null | undefined;
  unpricedEventCount?: number | null;
  format: (valueUsd: number) => string;
  className?: string;
}) {
  const note = describeMintBurnVolumeBound(completeness, unpricedEventCount);
  return (
    <span className={className} title={note ?? undefined}>
      {formatMintBurnVolume(valueUsd, completeness, format)}
      {note ? <span className="sr-only"> ({note})</span> : null}
    </span>
  );
}
