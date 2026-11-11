export function isLegacyStablecoinRedirectDestination(
  value: string,
  knownStablecoinIds: ReadonlySet<string>,
): boolean {
  const targetId = value.match(/^\/stablecoin\/([^/]+)\/$/)?.[1];
  return targetId != null
    ? knownStablecoinIds.has(targetId)
    : value === "/coverage/"
      || value === "/cemetery/"
      || /^\/cemetery\/#[a-z0-9][a-z0-9-]*$/.test(value)
      || /^\/stablecoins\/[a-z]+\/$/.test(value);
}
