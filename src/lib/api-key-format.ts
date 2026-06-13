export function formatEpochSecondsLocale(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}
