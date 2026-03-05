"use client";

import { CoinNotices } from "@/components/coin-notice";
import { OverviewSection } from "@/components/stablecoin-detail/overview-section";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type { StablecoinMeta } from "@shared/types";

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
  isNavToken: boolean;
}

export function NoticesAndSummarySection({
  stablecoinId,
  coin,
  summary,
  reserves,
  isNavToken,
}: NoticesAndSummarySectionProps) {
  return (
    <>
      <OverviewSection
        stablecoinId={stablecoinId}
        coin={coin}
        summary={summary}
        reserves={reserves}
        isNavToken={isNavToken}
      />

      {coin.notices && coin.notices.length > 0 && (
        <CoinNotices notices={coin.notices} />
      )}
    </>
  );
}
