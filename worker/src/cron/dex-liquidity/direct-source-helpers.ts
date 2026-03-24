export function normalizeFeeRateFromBps(feeBps: number | null | undefined): number | null {
  if (feeBps == null || !Number.isFinite(feeBps) || feeBps <= 0) return null;
  return feeBps / 10_000;
}

export function classifyClPoolType(
  protocol: "pancakeswap" | "aerodrome-slipstream" | "velodrome-slipstream",
  feeBps: number | null | undefined,
): string {
  const normalizedFeeBps = feeBps != null && Number.isFinite(feeBps) ? feeBps : 500;
  const prefix = protocol === "pancakeswap" ? "pancakeswap-v3" : protocol;
  if (normalizedFeeBps <= 1) return `${prefix}-1bp`;
  if (normalizedFeeBps <= 5) return `${prefix}-5bp`;
  return `${prefix}-30bp`;
}
