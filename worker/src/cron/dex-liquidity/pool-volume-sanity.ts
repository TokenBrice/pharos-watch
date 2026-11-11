const POOL_VOL_TO_TVL_RATIO_MAX = 50;
const LARGE_POOL_TVL_MIN_USD = 100_000_000;
const LARGE_POOL_MIN_VOLUME_USD = 50_000;

export function retainedPoolVolumeSanityRejection(
  tvlUsd: number,
  volumeUsd1d: number | null,
): "volume-to-tvl-ratio" | "large-pool-low-volume" | null {
  if (volumeUsd1d != null && tvlUsd > 0 && volumeUsd1d / tvlUsd > POOL_VOL_TO_TVL_RATIO_MAX) {
    return "volume-to-tvl-ratio";
  }
  if (tvlUsd > LARGE_POOL_TVL_MIN_USD && !(volumeUsd1d != null && volumeUsd1d >= LARGE_POOL_MIN_VOLUME_USD)) {
    return "large-pool-low-volume";
  }
  return null;
}

export function passesUsdVolumeSourcePreflight(tvlUsd: number, volume24hUsd: number | null): boolean {
  if (tvlUsd <= 0 || !Number.isFinite(tvlUsd)) return false;
  // Liquidity 6.9 admission semantics: only a measured (finite, non-negative)
  // reading participates. An absent reading is not a zero — it excludes
  // nothing from the vol/TVL sanity check and never clears the large-pool
  // volume floor, so small pools stay eligible without any volume evidence.
  const measuredVolume = volume24hUsd != null && Number.isFinite(volume24hUsd) && volume24hUsd >= 0 ? volume24hUsd : null;
  return retainedPoolVolumeSanityRejection(tvlUsd, measuredVolume) == null;
}

export function passesRawTokenVolumeSourcePreflight(tvlUsd: number, tokenVolumes: number[] | undefined): boolean {
  if (tvlUsd <= LARGE_POOL_TVL_MIN_USD) return true;
  if (tokenVolumes == null) return false;
  return tokenVolumes.some((volume) => Number.isFinite(volume) && volume >= LARGE_POOL_MIN_VOLUME_USD);
}
