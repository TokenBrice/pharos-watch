export type SourceStatus = "used" | "available" | "no-data" | "not-applicable";

export function resolvePriceTransparencySourceStatus(
  sourceKey: string,
  agreeSources: readonly string[],
  consensusSources: readonly string[],
  isProtocolRedeem: boolean,
): SourceStatus {
  if (isProtocolRedeem) return "not-applicable";
  if (agreeSources.includes(sourceKey)) return "used";
  if (consensusSources.includes(sourceKey)) return "available";
  return "no-data";
}

