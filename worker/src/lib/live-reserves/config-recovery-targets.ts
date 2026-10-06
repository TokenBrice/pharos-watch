/** Config refresh repairs proven prior bindings only; new bindings use the regular producer. */
export function selectConfigRecoveryTargets(
  previous: ReadonlyMap<string, string | null>,
  current: ReadonlyMap<string, string>,
  hasRegisteredFetcher: (stablecoinId: string) => boolean,
): { targets: string[]; missingFetcherIds: string[] } {
  const targets: string[] = [];
  const missingFetcherIds: string[] = [];
  for (const [id, fingerprint] of current) {
    const retained = previous.get(id);
    if (retained == null || retained === fingerprint) continue;
    if (!hasRegisteredFetcher(id)) {
      missingFetcherIds.push(id);
      continue;
    }
    targets.push(id);
  }
  return { targets, missingFetcherIds };
}
