import { CHAIN_META } from "@shared/lib/chains";
import type { StablecoinMeta } from "@shared/types";

type ContractDeployment = NonNullable<StablecoinMeta["contracts"]>[number];

export interface ContractDeploymentParts {
  count: number;
  /** First four deployments, used for the inline chain list. */
  sample: ContractDeployment[];
  /** Resolved chain display names for `sample`, in order. */
  chainNames: string[];
  /** Deployments beyond `sample`. */
  remaining: number;
  deploymentLabel: "deployment" | "deployments";
}

/**
 * Shared data parts for the "N deployments tracked across …" contract summary.
 * Callers keep their own rendering (plain string vs. linked chain list).
 */
export function buildContractDeploymentParts(contracts: StablecoinMeta["contracts"]): ContractDeploymentParts {
  const list = contracts ?? [];
  const sample = list.slice(0, 4);
  const chainNames = sample.map((c) => CHAIN_META[c.chain]?.name ?? c.chain);
  return {
    count: list.length,
    sample,
    chainNames,
    remaining: Math.max(list.length - sample.length, 0),
    deploymentLabel: list.length === 1 ? "deployment" : "deployments",
  };
}
