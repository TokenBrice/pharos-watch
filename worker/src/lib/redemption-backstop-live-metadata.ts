import type { ReserveSnapshotMetadataRecord } from "./live-reserves-store";
import { LIVE_RESERVE_FRESHNESS_SEC } from "./live-reserves-store";

export interface RedemptionBackstopLiveMetadata {
  updatedAt: number | null;
  isFresh: boolean;
  immediateRedeemableUsd: number | null;
  immediateRedeemableRatio: number | null;
  redemptionFeeBps: number | null;
  buyFeeBpsMin: number | null;
  buyFeeBpsMax: number | null;
}

function coerceFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readRedemptionBackstopLiveMetadata(
  snapshotMetadata: ReserveSnapshotMetadataRecord | null | undefined,
  now = Math.floor(Date.now() / 1000),
): RedemptionBackstopLiveMetadata {
  const metadata = snapshotMetadata?.metadata ?? {};
  const updatedAt = snapshotMetadata?.fetchedAt ?? null;

  return {
    updatedAt,
    isFresh: updatedAt != null && now - updatedAt <= LIVE_RESERVE_FRESHNESS_SEC,
    immediateRedeemableUsd: coerceFiniteNumber(metadata.immediateRedeemableUsd),
    immediateRedeemableRatio: coerceFiniteNumber(metadata.immediateRedeemableRatio),
    redemptionFeeBps: coerceFiniteNumber(metadata.redemptionFeeBps),
    buyFeeBpsMin: coerceFiniteNumber(metadata.buyFeeBpsMin),
    buyFeeBpsMax: coerceFiniteNumber(metadata.buyFeeBpsMax),
  };
}
