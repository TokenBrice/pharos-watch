import type { AdapterResult } from "./types";
import type { BranchBalanceEntry } from "./branch-balances";
import { decimalNumberFromBigInt } from "./helpers";

export function applyBabelFishAccounting({ coinId, debtSelector, debtRaw, debtDecimals, balances, censusComplete, result, totalDebtUsd }: {
  coinId: string;
  debtSelector: string | undefined;
  debtRaw: bigint | null;
  debtDecimals: number;
  balances: BranchBalanceEntry[];
  censusComplete: boolean;
  result: AdapterResult;
  totalDebtUsd: number | undefined;
}): void {
  if (coinId === "xusd-babelfish" && debtSelector === "0x18160ddd" && debtRaw != null) {
    const details = result.metadata!.details as Record<string, unknown>;
    details.valuationBasis = "mixed-nominal-market";
    details.liabilityBasis = "totalSupply-at-par";
    details.liabilityRaw = debtRaw.toString();
    // This reviewed USD basket has ten native, 18-decimal balances. Do not
    // generalize at-par reconciliation to arbitrary collateral or receipts.
    if (censusComplete && result.metadata?.valuationComplete === true
      && debtDecimals === 18 && balances.length === 10
      && balances.every(({ branch, balanceRaw, observedDecimals, balanceDecimals }) =>
        balanceRaw != null && observedDecimals === 18n && branch.token.decimals === 18
        && balanceDecimals == null && branch.receipt == null)) {
      const nominalReserveRaw = balances.reduce((sum, entry) => sum + entry.balanceRaw!, 0n);
      details.nominalReconciliation = {
        basis: "reviewed-USD-basket-at-par",
        reserveRaw: nominalReserveRaw.toString(),
        liabilityRaw: debtRaw.toString(),
        shortfallRaw: (debtRaw - nominalReserveRaw).toString(),
        decimals: 18,
        reserveAtParUsd: decimalNumberFromBigInt(nominalReserveRaw, 18),
        shortfallAtParUsd: decimalNumberFromBigInt(debtRaw - nominalReserveRaw, 18),
        ...(debtRaw > 0n
          ? { ratio: decimalNumberFromBigInt(nominalReserveRaw, 18) / totalDebtUsd! }
          : {}),
      };
    }
  }
}
