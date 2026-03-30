import {
  type DexLiquidityMap,
  type MintBurnFlowsResponse,
  type StabilityIndexResponse,
  type StablecoinListResponse,
  type StressSignalsAllResponse,
} from "@shared/types";
import { getDisplayedPsi, getPsiBandStreak, getPsiCompletedDayPoint } from "@shared/lib/psi-view-model";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@shared/lib/supply";

export function buildStablecoinSnapshot(stablecoinsData?: StablecoinListResponse) {
  if (!stablecoinsData?.peggedAssets) {
    return {
      totalMcap: 0,
      mcapChange24hPct: 0,
      mcapChange7dPct: 0,
      usdtUsdcSharePct: 0,
    };
  }

  let totalMcap = 0;
  let totalPrevDay = 0;
  let totalPrevWeek = 0;
  let usdtUsdcTotal = 0;

  for (const coin of stablecoinsData.peggedAssets) {
    const supply = getCirculatingRaw(coin);
    totalMcap += supply;
    totalPrevDay += getPrevDayRaw(coin);
    totalPrevWeek += getPrevWeekRaw(coin);

    const symbol = coin.symbol?.toUpperCase();
    if (symbol === "USDT" || symbol === "USDC") {
      usdtUsdcTotal += supply;
    }
  }

  return {
    totalMcap,
    mcapChange24hPct: totalPrevDay > 0 ? ((totalMcap - totalPrevDay) / totalPrevDay) * 100 : 0,
    mcapChange7dPct: totalPrevWeek > 0 ? ((totalMcap - totalPrevWeek) / totalPrevWeek) * 100 : 0,
    usdtUsdcSharePct: totalMcap > 0 ? (usdtUsdcTotal / totalMcap) * 100 : 0,
  };
}

export function buildDexSnapshot(dexData: DexLiquidityMap | undefined, totalMcap: number) {
  if (!dexData) {
    return {
      totalVol24h: 0,
      volVs7dAvgPct: 0,
      turnoverPct: 0,
    };
  }

  let totalVol24h = 0;
  let totalVol7d = 0;
  for (const liquidity of Object.values(dexData)) {
    totalVol24h += liquidity.totalVolume24hUsd;
    totalVol7d += liquidity.totalVolume7dUsd;
  }

  const avg7d = totalVol7d / 7;
  return {
    totalVol24h,
    volVs7dAvgPct: avg7d > 0 ? ((totalVol24h - avg7d) / avg7d) * 100 : 0,
    turnoverPct: totalMcap > 0 ? (totalVol24h / totalMcap) * 100 : 0,
  };
}

export function buildFlowSnapshot(flowData?: MintBurnFlowsResponse) {
  if (!flowData?.coins?.length) {
    return { netFlow24h: 0, netFlow7d: 0 };
  }

  let netFlow24h = 0;
  let netFlow7d = 0;
  for (const coin of flowData.coins) {
    netFlow24h += coin.netFlow24hUsd;
    netFlow7d += coin.netFlow7dUsd;
  }

  return { netFlow24h, netFlow7d };
}

export function buildPsiSnapshot(psiData?: StabilityIndexResponse) {
  const psiCurrent = psiData?.current;
  const displayedPsi = psiCurrent ? getDisplayedPsi(psiCurrent) : null;
  const psiScoreNum = displayedPsi?.score ?? null;
  const psiBand = displayedPsi?.band ?? "";
  const psiDayAnchor = psiCurrent?.computedAt ?? null;

  if (!psiBand || !psiData?.history || psiScoreNum === null || psiDayAnchor === null) {
    return {
      psiCurrent,
      psiScoreNum,
      psiBand,
      psiDayAnchor,
      psiDaysInBand: 0,
      psiDelta24h: null,
      psiDelta7d: null,
      psiDelta30d: null,
    };
  }

  const previousDay = getPsiCompletedDayPoint(psiData.history, psiDayAnchor, 1);
  const previousWeek = getPsiCompletedDayPoint(psiData.history, psiDayAnchor, 7);
  const previousMonth = getPsiCompletedDayPoint(psiData.history, psiDayAnchor, 30);

  return {
    psiCurrent,
    psiScoreNum,
    psiBand,
    psiDayAnchor,
    psiDaysInBand: getPsiBandStreak(psiData.history, psiDayAnchor, psiBand),
    psiDelta24h: previousDay ? psiScoreNum - previousDay.score : null,
    psiDelta7d: previousWeek ? psiScoreNum - previousWeek.score : null,
    psiDelta30d: previousMonth ? psiScoreNum - previousMonth.score : null,
  };
}

export function buildDewsBandCounts(stressData?: StressSignalsAllResponse) {
  if (!stressData?.signals) return null;

  let danger = 0;
  let alert = 0;
  let warning = 0;
  for (const entry of Object.values(stressData.signals)) {
    if (entry.band === "DANGER") danger++;
    else if (entry.band === "ALERT") alert++;
    else if (entry.band === "WARNING") warning++;
  }

  return { danger, alert, warning };
}
