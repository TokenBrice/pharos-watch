import type { DeadStablecoin } from "../types/cemetery";
import deadStablecoinAsset from "../data/dead-stablecoins.json";
import { parseDeadStablecoinAssets } from "./stablecoins/schema";

export const DEAD_STABLECOINS: DeadStablecoin[] = parseDeadStablecoinAssets(
  deadStablecoinAsset,
  "shared/data/dead-stablecoins.json",
);
