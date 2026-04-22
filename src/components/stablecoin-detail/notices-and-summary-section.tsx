"use client";

import { CoinNotices } from "@/components/coin-notice";
import { OverviewSection } from "@/components/stablecoin-detail/overview-section";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type {
  PegSummaryCoin,
  RedemptionBackstopEntry,
  StablecoinAiSummary,
  StablecoinMeta,
  StablecoinData,
} from "@shared/types";

interface NoticesAndSummarySectionProps {
  stablecoinId: string;
  coin: StablecoinMeta;
  summary: StablecoinAiSummary | null;
  reserves: ReserveResult | null;
  reserveFetchError: unknown | null;
  redemptionBackstop?: RedemptionBackstopEntry;
  isNavToken: boolean;
  coinData?: StablecoinData;
  consensusSources?: string[];
  agreeSources?: string[];
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
  agreeSources,
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
        agreeSources={agreeSources}
        dexPriceCheck={dexPriceCheck}
      />

      {/* Filter out danger notices - they're shown prominently in ExploitNoticeBanner above */}
      {coin.notices && coin.notices.length > 0 && (
        <CoinNotices notices={coin.notices.filter((n) => n.type !== "danger")} />
      )}
    </>
  );
}
