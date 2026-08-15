import type { StablecoinMeta } from "@shared/types";

const DEFAULT_FLAGS: StablecoinMeta["flags"] = {
  backing: "rwa-backed",
  pegCurrency: "USD",
  governance: "centralized",
  yieldBearing: false,
  rwa: false,
  navToken: false,
};

export function makeCoverageCoin(
  input: Partial<StablecoinMeta> & Pick<StablecoinMeta, "id">,
  options: { defaultLinks?: boolean } = {},
): StablecoinMeta {
  return {
    ...input,
    name: input.name ?? input.id,
    symbol: input.symbol ?? input.id.toUpperCase(),
    flags: input.flags ?? DEFAULT_FLAGS,
    collateral: input.collateral ?? "Fixture collateral",
    pegMechanism: input.pegMechanism ?? "Fixture mechanism",
    ...(options.defaultLinks
      ? { links: input.links ?? [{ label: "Website", url: `https://example.com/${input.id}` }] }
      : {}),
  };
}
