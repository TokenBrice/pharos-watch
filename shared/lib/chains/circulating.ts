import { resolveChainId } from "./index";

export interface ChainCirculatingPoint {
  current: number;
  circulatingPrevDay: number;
  circulatingPrevWeek: number;
  circulatingPrevMonth: number;
}

export type RawChainCirculating = Record<string, {
  current?: number;
  circulatingPrevDay?: number;
  circulatingPrevWeek?: number;
  circulatingPrevMonth?: number;
}>;

function sanitizeSupply(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
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
    const chainId = resolveChainId(rawChainId);
    if (!chainId) continue;

    const current = sanitizeSupply(data.current);
    const circulatingPrevDay = sanitizeSupply(data.circulatingPrevDay);
    const circulatingPrevWeek = sanitizeSupply(data.circulatingPrevWeek);
    const circulatingPrevMonth = sanitizeSupply(data.circulatingPrevMonth);
    const existing = canonical.get(chainId);

    if (existing) {
      existing.current = addSupply(existing.current, current);
      existing.circulatingPrevDay = addSupply(existing.circulatingPrevDay, circulatingPrevDay);
      existing.circulatingPrevWeek = addSupply(existing.circulatingPrevWeek, circulatingPrevWeek);
      existing.circulatingPrevMonth = addSupply(existing.circulatingPrevMonth, circulatingPrevMonth);
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

export function findCanonicalChainData(
  chainCirculating: RawChainCirculating | null | undefined,
  targetChainId: string,
): ChainCirculatingPoint | null {
  return canonicalizeChainCirculating(chainCirculating).get(targetChainId) ?? null;
}
