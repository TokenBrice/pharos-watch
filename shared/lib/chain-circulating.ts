import { resolveChainId } from "./chains";

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

    const current = data.current ?? 0;
    const circulatingPrevDay = data.circulatingPrevDay ?? 0;
    const circulatingPrevWeek = data.circulatingPrevWeek ?? 0;
    const circulatingPrevMonth = data.circulatingPrevMonth ?? 0;
    const existing = canonical.get(chainId);

    if (existing) {
      existing.current += current;
      existing.circulatingPrevDay += circulatingPrevDay;
      existing.circulatingPrevWeek += circulatingPrevWeek;
      existing.circulatingPrevMonth += circulatingPrevMonth;
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
