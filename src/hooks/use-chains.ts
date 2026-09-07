"use client";

import { type ChainsResponse } from "@shared/types/chains";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { useRegisteredApiQuery } from "./api-hooks";

export function useChains() {
  return useRegisteredApiQuery<ChainsResponse>(FRONTEND_API_QUERY_DESCRIPTORS.chains);
}
export function useChainDetail(chainId: string) {
  return useRegisteredApiQuery<ChainsResponse>(FRONTEND_API_QUERY_DESCRIPTORS.chainsDetail(chainId));
}
