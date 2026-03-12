"use client";

import { CoinNotices } from "@/components/coin-notice";
import { OverviewSection } from "@/components/stablecoin-detail/overview-section";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type { RedemptionBackstopEntry, StablecoinMeta } from "@shared/types";

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
}

export function NoticesAndSummarySection({
  stablecoinId,
  coin,
  summary,
  reserves,
  reserveFetchError,
  redemptionBackstop,
  isNavToken,
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
      />

      {coin.notices && coin.notices.length > 0 && (
        <CoinNotices notices={coin.notices} />
      )}
    </>
  );
}
