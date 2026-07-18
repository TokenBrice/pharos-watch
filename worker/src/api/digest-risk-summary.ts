import type { DigestInputData, DigestRiskSignal } from "@shared/types/digest";
import { isCriticalDepegRisk } from "@shared/lib/digest-risk";
import { isRecord } from "@shared/lib/type-guards";

type DailyDigestLike = Pick<DigestInputData, "activeDepegCount" | "topDepegs">;

function isDailyDigestLike(value: unknown): value is DailyDigestLike {
  return isRecord(value) && Array.isArray(value.topDepegs);
}

type DepegRiskInput = { bps: number; mcapUsd: number; impactScore?: number | null; currentBps?: number | null };

// Rows stored by the current pipeline carry the live deviation in currentBps;
// archived rows only have the event's peak in bps. Prefer live when present.
function depegSignalBps(depeg: DepegRiskInput): number {
  return depeg.currentBps ?? depeg.bps;
}

function depegImpactScore(depeg: DepegRiskInput): number {
  return depeg.impactScore ?? Math.abs(depegSignalBps(depeg)) * depeg.mcapUsd;
}

function compareDepegRisk(a: DepegRiskInput, b: DepegRiskInput): number {
  const criticalDelta =
    Number(isCriticalDepegRisk({ bps: depegSignalBps(b), mcapUsd: b.mcapUsd })) -
    Number(isCriticalDepegRisk({ bps: depegSignalBps(a), mcapUsd: a.mcapUsd }));
  return criticalDelta || depegImpactScore(b) - depegImpactScore(a) || Math.abs(depegSignalBps(b)) - Math.abs(depegSignalBps(a));
}

function compareDigestRiskSignal(a: DigestRiskSignal, b: DigestRiskSignal): number {
  return compareDepegRisk(
    { bps: a.bps, mcapUsd: a.mcapUsd ?? 0 },
    { bps: b.bps, mcapUsd: b.mcapUsd ?? 0 },
  );
}

function selectTopDepeg(input: DailyDigestLike, date?: string | null): DigestRiskSignal | null {
  const top = input.topDepegs
    .filter((depeg) => Number.isFinite(depeg.bps))
    .sort(compareDepegRisk)[0];
  if (!top) return null;
  const signalBps = depegSignalBps(top);
  return {
    kind: "depeg",
    symbol: top.symbol,
    bps: signalBps,
    mcapUsd: Number.isFinite(top.mcapUsd) ? top.mcapUsd : null,
    severity: isCriticalDepegRisk({ bps: signalBps, mcapUsd: top.mcapUsd }) ? "critical" : "watch",
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
      .sort(compareDigestRiskSignal);
    return candidates[0] ?? null;
  }

  return null;
}
