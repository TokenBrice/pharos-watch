import { formatCompactUsdShort } from "@shared/lib/format";

export function formatTelegramCompactUsd(value: number | null | undefined): string | null {
  return Number.isFinite(value) ? formatCompactUsdShort(value as number) : null;
}
