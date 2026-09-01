import type { ContractDeployment } from "@shared/types/core";
import type { DexDeploymentProviderCheck } from "../types";
import type { CrawlStageContext } from "../staged-pool";

export interface PredeclaredDiscoveryProviderLeafInput {
  coinTargets: readonly ContractDeployment[];
  context: CrawlStageContext;
}

export const SOROBAN_EXHAUSTIVE_DISCOVERY_PROVIDER_SLOT = {
  lifecycle: "disabled" as const,
  supports: (_chain: string, _address?: string): boolean => false,
  async crawl(_input: PredeclaredDiscoveryProviderLeafInput): Promise<{
    providerChecks: DexDeploymentProviderCheck[];
    stoppedEarly: boolean;
  }> {
    return { providerChecks: [], stoppedEarly: false };
  },
};
