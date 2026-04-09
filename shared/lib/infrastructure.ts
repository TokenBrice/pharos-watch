import type { Infrastructure } from "../types";
import { INFRASTRUCTURE_LABELS } from "../types/core";

export function getInfrastructureLabel(value: Infrastructure): string {
  return INFRASTRUCTURE_LABELS[value];
}

export function getInfrastructureSummary(value: Infrastructure): string {
  switch (value) {
    case "liquity-v1":
      return "Built on the original Liquity design: 110% liquidation threshold, Stability Pool liquidations, no ongoing borrower interest. Forked codebase with independent reserves.";
    case "liquity-v2":
      return "Built on the Liquity v2 / BOLD design: user-set borrower rates, branch-style collateral markets, Stability Pools. Forked codebase with independent reserves.";
    case "m0":
      return "Built on the M0 issuance platform: minter governance, SwapFacility, and the MExtension.sol contract pattern. Reserve composition is set by the issuer and may or may not include the underlying $M token.";
  }
}
