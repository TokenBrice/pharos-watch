"use client";

import { DepegHistory } from "@/components/depeg-history";

interface DepegHistorySectionProps {
  stablecoinId: string;
  earliestTrackingDate: string | null;
  hasPriceData: boolean;
  isNavToken: boolean;
}

export function DepegHistorySection({
  stablecoinId,
  earliestTrackingDate,
  hasPriceData,
  isNavToken,
}: DepegHistorySectionProps) {
  if (isNavToken) return null;

  return (
    <section id="history">
      <DepegHistory
        stablecoinId={stablecoinId}
        earliestTrackingDate={earliestTrackingDate}
        hasPriceData={hasPriceData}
      />
    </section>
  );
}
