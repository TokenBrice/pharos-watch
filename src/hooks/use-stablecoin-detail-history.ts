"use client";

import { useSupplyHistory } from "@/hooks/use-stablecoins";

export function useStablecoinDetailHistory(id: string) {
  return useSupplyHistory(id);
}
