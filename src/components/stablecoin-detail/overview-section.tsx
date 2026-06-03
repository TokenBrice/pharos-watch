"use client";

import { ReservePanel, type ReservePanelProps } from "./reserve-panel";

export type OverviewSectionProps = ReservePanelProps;

export function OverviewSection({
  coin,
  reserves,
  reserveFetchError,
  onRetry,
  isFetching,
}: OverviewSectionProps) {
  return (
    <ReservePanel
      coin={coin}
      reserves={reserves}
      reserveFetchError={reserveFetchError}
      onRetry={onRetry}
      isFetching={isFetching}
    />
  );
}
