import { type StablecoinClientMeta } from "./stablecoins/client-registry";
import { CLIENT_ACTIVE_STABLECOINS } from "./stablecoins/client-registry";
import { PSI_HISTORICAL_META_BY_ID } from "./psi-historical-assets";

type ClientPsiEligibleMeta = Pick<StablecoinClientMeta, "id" | "name" | "symbol">;

/** Slim client monitoring lookup = all active listings plus PSI historical assets. */
export const CLIENT_PSI_ELIGIBLE_META_BY_ID: ReadonlyMap<string, ClientPsiEligibleMeta> = new Map([
  ...CLIENT_ACTIVE_STABLECOINS.map((meta) => [meta.id, meta] as const),
  ...[...PSI_HISTORICAL_META_BY_ID].map(
    ([id, meta]) =>
      [
        id,
        {
          id: meta.id,
          name: meta.name,
          symbol: meta.symbol,
        },
      ] as const,
  ),
]);
