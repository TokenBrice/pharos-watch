import { formatCompactUsdShort } from "@shared/lib/format";

export function formatTelegramCompactUsd(value: number | null | undefined): string | null {
  return Number.isFinite(value) ? formatCompactUsdShort(value as number) : null;
}

/**
 * Compact USD with an explicit sign for net-flow display ("+$12.3M" / "-$4.0M" / "$0").
 * Returns null for non-finite input so callers can drop the line.
 */
export function formatTelegramSignedCompactUsd(value: number | null | undefined): string | null {
  if (!Number.isFinite(value)) return null;
  const v = value as number;
  const compact = formatCompactUsdShort(Math.abs(v));
  if (v > 0) return `+${compact}`;
  if (v < 0) return `-${compact}`;
  return compact;
}
