import type { StablecoinMeta } from "@shared/types";

export function getTrackedAlgorithmicBackingIssue(
  coin: Pick<StablecoinMeta, "flags">,
): string | null {
  return coin.flags.backing === "algorithmic"
    ? "tracked stablecoin metadata must not use legacy flags.backing=algorithmic; classify by actual collateral base or keep algorithmic metadata shadow-only"
    : null;
}
