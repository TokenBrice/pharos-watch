import { cn } from "@/lib/utils";
import type { MintBurnValuationCompleteness } from "@shared/types";
import {
  describeMintBurnVolumeBound,
  formatMintBurnVolume,
  type MintBurnSignedNetView,
} from "@shared/lib/mint-burn-valuation-display";

/**
 * Signed mint/burn net with valuation-completeness semantics: an unavailable net
 * (null, or partial valuation) renders the placeholder with an accessible reason,
 * never $0, unless it carries a proven one-sided bound, which renders as an explicit
 * `≥`/`≤` value; a coverage-unknown net keeps its value with a subtle marker.
 */
export function FlowSignedNetValue({
  net,
  format,
  colorClassName,
  className,
  placeholder = "—",
  unknownMarker = "visible",
}: {
  net: MintBurnSignedNetView;
  format: (valueUsd: number) => string;
  /** Color class for an available value, e.g. `getNetColor`. */
  colorClassName?: (valueUsd: number) => string;
  className?: string;
  placeholder?: string;
  /**
   * `sr-only`: keep the coverage-unknown reason for assistive tech but drop the
   * visible `*`, for surfaces (the flows table) that state it once in a column
   * header chip instead of on almost every cell.
   */
  unknownMarker?: "visible" | "sr-only";
}) {
  if (net.valueUsd == null && net.bound) {
    const { kind, valueUsd } = net.bound;
    // Colour only when the bound already proves the sign; otherwise the bound stays neutral.
    const provesSign = kind === "lower" ? valueUsd > 0 : valueUsd < 0;
    return (
      <span
        className={cn(provesSign ? colorClassName?.(valueUsd) : "text-muted-foreground", className)}
        title={net.note ?? undefined}
      >
        {kind === "lower" ? "≥ " : "≤ "}
        {format(valueUsd)}
        <span className="sr-only"> ({net.note ?? (kind === "lower" ? "lower bound" : "upper bound")})</span>
      </span>
    );
  }
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
          {unknownMarker === "visible" ? (
            <span aria-hidden="true" className="ml-0.5 align-super text-[0.65em] text-muted-foreground">*</span>
          ) : null}
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
  scanComplete,
  format,
  className,
}: {
  valueUsd: number;
  completeness: MintBurnValuationCompleteness | null | undefined;
  unpricedEventCount?: number | null;
  scanComplete?: boolean;
  format: (valueUsd: number) => string;
  className?: string;
}) {
  const note = describeMintBurnVolumeBound(completeness, unpricedEventCount, scanComplete);
  return (
    <span className={className} title={note ?? undefined}>
      {formatMintBurnVolume(valueUsd, completeness, format, scanComplete)}
      {note ? <span className="sr-only"> ({note})</span> : null}
    </span>
  );
}
