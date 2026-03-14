"use client";

import { CoinNotices } from "@/components/coin-notice";
import { OverviewSection } from "@/components/stablecoin-detail/overview-section";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type { PegSummaryCoin, RedemptionBackstopEntry, StablecoinMeta, StablecoinData } from "@shared/types";

interface SummaryData {
  title: string;
  text: string;
  updatedAt: string;
}

interface NoticesAndSummarySectionProps {
  stablecoinId: string;
  coin: StablecoinMeta;
  summary: SummaryData | null;
  reserves: ReserveResult | null;
  reserveFetchError: unknown | null;
  redemptionBackstop?: RedemptionBackstopEntry;
  isNavToken: boolean;
  coinData?: StablecoinData;
  consensusSources?: string[];
  dexPriceCheck?: PegSummaryCoin["dexPriceCheck"];
}

export function NoticesAndSummarySection({
  stablecoinId,
  coin,
  summary,
  reserves,
  reserveFetchError,
  redemptionBackstop,
  isNavToken,
  coinData,
  consensusSources,
  dexPriceCheck,
}: NoticesAndSummarySectionProps) {
  return (
    <>
      <OverviewSection
        stablecoinId={stablecoinId}
        coin={coin}
        summary={summary}
        reserves={reserves}
        reserveFetchError={reserveFetchError}
        redemptionBackstop={redemptionBackstop}
        isNavToken={isNavToken}
        coinData={coinData}
        consensusSources={consensusSources}
        dexPriceCheck={dexPriceCheck}
      />

      {coin.notices && coin.notices.length > 0 && (
        <CoinNotices notices={coin.notices} />
      )}
    </>
  );
}
