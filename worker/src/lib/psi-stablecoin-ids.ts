const PSI_STABLECOIN_ID_ALIASES = new Map<string, string>([
  // UST historical depeg rows were recorded under the post-collapse legacy id,
  // while PSI supply/shadow coverage now keys the asset as `ust-terra`.
  ["ust-terra-classic", "ust-terra"],
]);

export function canonicalizePsiStablecoinId(stablecoinId: string): string {
  return PSI_STABLECOIN_ID_ALIASES.get(stablecoinId) ?? stablecoinId;
}
