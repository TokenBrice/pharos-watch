export function isSlidingWindowRateLimited(
  timestampsByKey: Map<string, number[]>,
  key: string,
  now: number,
  windowMs: number,
  maxPerWindow: number,
  maxTrackedKeys: number,
): boolean {
  const cutoff = now - windowMs;
  const recent = (timestampsByKey.get(key) ?? []).filter((ts) => ts > cutoff);
  if (recent.length >= maxPerWindow) {
    timestampsByKey.set(key, recent);
    return true;
  }

  recent.push(now);
  if (!timestampsByKey.has(key) && timestampsByKey.size >= maxTrackedKeys) {
    const oldest = timestampsByKey.keys().next().value;
    if (oldest !== undefined) timestampsByKey.delete(oldest);
  }
  timestampsByKey.set(key, recent);
  return false;
}
