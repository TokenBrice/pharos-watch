import type { DigestInputData, DigestRiskSignal } from "@shared/types/digest";
import { isCriticalDepegRisk } from "@shared/lib/digest-risk";
import { isRecord } from "@shared/lib/type-guards";

type DailyDigestLike = Pick<DigestInputData, "activeDepegCount" | "topDepegs">;

function isDailyDigestLike(value: unknown): value is DailyDigestLike {
  return isRecord(value) && Array.isArray(value.topDepegs);
}

function selectTopDepeg(input: DailyDigestLike, date?: string | null): DigestRiskSignal | null {
  const top = input.topDepegs
    .filter((depeg) => Number.isFinite(depeg.bps))
    .sort((a, b) => Math.abs(b.bps) - Math.abs(a.bps) || (b.impactScore ?? 0) - (a.impactScore ?? 0))[0];
  if (!top) return null;
  return {
    kind: "depeg",
    symbol: top.symbol,
    bps: top.bps,
    mcapUsd: Number.isFinite(top.mcapUsd) ? top.mcapUsd : null,
    severity: isCriticalDepegRisk({ bps: top.bps, mcapUsd: top.mcapUsd }) ? "critical" : "watch",
    activeCount: input.activeDepegCount,
    date: date ?? null,
  };
}

export function selectDigestRiskSignal(input: unknown): DigestRiskSignal | null {
  if (!input || !isRecord(input)) return null;

  if (isDailyDigestLike(input)) {
    return selectTopDepeg(input);
  }

  if (Array.isArray(input.dailyDigests)) {
    const candidates = input.dailyDigests
      .map((entry) => {
        if (!isRecord(entry)) return null;
        const dailyInput = entry.inputData;
        if (!isDailyDigestLike(dailyInput)) return null;
        const date = typeof entry.date === "string" ? entry.date : null;
        return selectTopDepeg(dailyInput, date);
      })
      .filter((entry): entry is DigestRiskSignal => entry !== null)
      .sort((a, b) => Math.abs(b.bps) - Math.abs(a.bps) || (b.mcapUsd ?? 0) - (a.mcapUsd ?? 0));
    return candidates[0] ?? null;
  }

  return null;
}
