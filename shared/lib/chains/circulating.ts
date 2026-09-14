import { resolveChainId } from "./index";

export interface ChainCirculatingPoint {
  current: number;
  circulatingPrevDay?: number;
  circulatingPrevWeek?: number;
  circulatingPrevMonth?: number;
}

export type RawChainCirculating = Record<string, {
  chainId?: string;
  current?: number;
  circulatingPrevDay?: number;
  circulatingPrevWeek?: number;
  circulatingPrevMonth?: number;
}>;

function sanitizeSupply(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function addSupply(current: number, value: number): number {
  const total = current + value;
  return Number.isFinite(total) ? total : Number.MAX_VALUE;
}

export function canonicalizeChainCirculating(
  chainCirculating: RawChainCirculating | null | undefined,
): Map<string, ChainCirculatingPoint> {
  const canonical = new Map<string, ChainCirculatingPoint>();
  if (!chainCirculating || typeof chainCirculating !== "object") {
    return canonical;
  }

  for (const [rawChainId, data] of Object.entries(chainCirculating)) {
    if (!data || typeof data !== "object") continue;
    // Worker-generated rows retain their display-label key for compatibility,
    // but the explicit canonical id is authoritative when present. Unknown or
    // malformed ids fall back to the legacy label resolver.
    const chainId = (typeof data.chainId === "string" ? resolveChainId(data.chainId) : null)
      ?? resolveChainId(rawChainId);
    if (!chainId) continue;

    const current = sanitizeSupply(data.current) ?? 0;
    const circulatingPrevDay = sanitizeSupply(data.circulatingPrevDay);
    const circulatingPrevWeek = sanitizeSupply(data.circulatingPrevWeek);
    const circulatingPrevMonth = sanitizeSupply(data.circulatingPrevMonth);
    const existing = canonical.get(chainId);

    if (existing) {
      existing.current = addSupply(existing.current, current);
      existing.circulatingPrevDay = existing.circulatingPrevDay == null || circulatingPrevDay == null
        ? undefined : addSupply(existing.circulatingPrevDay, circulatingPrevDay);
      existing.circulatingPrevWeek = existing.circulatingPrevWeek == null || circulatingPrevWeek == null
        ? undefined : addSupply(existing.circulatingPrevWeek, circulatingPrevWeek);
      existing.circulatingPrevMonth = existing.circulatingPrevMonth == null || circulatingPrevMonth == null
        ? undefined : addSupply(existing.circulatingPrevMonth, circulatingPrevMonth);
      continue;
    }

    canonical.set(chainId, {
      current,
      circulatingPrevDay,
      circulatingPrevWeek,
      circulatingPrevMonth,
    });
  }

  return canonical;
}
