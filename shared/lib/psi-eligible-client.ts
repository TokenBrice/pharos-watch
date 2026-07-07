import {
  CLIENT_ACTIVE_META_BY_ID,
  type StablecoinClientMeta,
} from "./stablecoins/client-registry";
import { SHADOW_META_BY_ID } from "./shadow-stablecoins";

type ClientPsiEligibleMeta = Pick<StablecoinClientMeta, "id" | "name" | "symbol">;

/** Slim client-side PSI lookup = active tracked + shadow PSI assets. */
export const CLIENT_PSI_ELIGIBLE_META_BY_ID: ReadonlyMap<string, ClientPsiEligibleMeta> = new Map([
  ...[...CLIENT_ACTIVE_META_BY_ID].map(([id, meta]) => [id, meta] as const),
  ...[...SHADOW_META_BY_ID].map(([id, meta]) => [id, {
    id: meta.id,
    name: meta.name,
    symbol: meta.symbol,
  }] as const),
]);
