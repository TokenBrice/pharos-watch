/** Config refresh repairs existing evidence only; new bindings use the regular producer. */
export function selectConfigRecoveryTargets(
  previous: ReadonlyMap<string, string | null>,
  current: ReadonlyMap<string, string>,
  hasRegisteredFetcher: (stablecoinId: string) => boolean,
): string[] {
  const targets: string[] = [];
  for (const [id, fingerprint] of current) {
    const retained = previous.get(id);
    if (retained == null || retained === fingerprint) continue;
    if (!hasRegisteredFetcher(id)) {
      throw new Error(`Live reserve config recovery has no registered fetcher for ${id}`);
    }
    targets.push(id);
  }
  return targets;
}
