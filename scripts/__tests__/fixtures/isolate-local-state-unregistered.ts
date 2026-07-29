const unregisteredFixtureCache = new Map<string, number>();

export function recordFixtureValue(key: string): void {
  unregisteredFixtureCache.set(key, (unregisteredFixtureCache.get(key) ?? 0) + 1);
}
