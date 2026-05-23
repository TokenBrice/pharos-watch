import type { DependencyType } from "@shared/types";

export interface CollateralUsageCoin {
  id: string;
  name: string;
  symbol: string;
}

export interface CollateralUsageEntry {
  coin: CollateralUsageCoin;
  weight: number;
  type: DependencyType;
}
