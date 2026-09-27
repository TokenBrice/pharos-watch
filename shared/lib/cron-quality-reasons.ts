/** Findings are operator warnings, independent of whether required work completed. */
export function getCronQualityReasons(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const quality = (metadata as Record<string, unknown>).quality;
  if (!quality || typeof quality !== "object" || Array.isArray(quality)) return [];
  const record = quality as Record<string, unknown>;
  const reasons: string[] = [];
  if (typeof record.reason === "string" && record.reason.trim()) reasons.push(record.reason);
  if (Array.isArray(record.reasons)) {
    for (const reason of record.reasons) {
      if (typeof reason === "string" && reason.trim()) reasons.push(reason);
    }
  }
  if (record.sources && typeof record.sources === "object" && !Array.isArray(record.sources)) {
    for (const [source, sourceQuality] of Object.entries(record.sources)) {
      for (const reason of getCronQualityReasons({ quality: sourceQuality })) {
        reasons.push(`${source}:${reason}`);
      }
    }
  }
  return [...new Set(reasons)];
}
