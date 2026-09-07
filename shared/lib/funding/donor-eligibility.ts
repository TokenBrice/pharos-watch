import type { Donation } from "./schema";
import type { ReportCardGrade } from "../../types/report-card-grade";

// Reconciled stablecoin symbols in the ledger. New assets require curation review
// before granting access; arbitrary ledger tokens must not qualify by default.
const DONATION_STABLECOIN_IDS: Readonly<Record<string, string>> = {
  USDC: "usdc-circle",
  USDT: "usdt-tether",
  DAI: "dai-makerdao",
  USDGLO: "usdglo-glo",
};

/**
 * Sums receipt-date USD for stablecoins graded in the A/B bands at claim time, excluding
 * `pool` rows: pool senders are payout contracts (for example Giveth) and can
 * never sign a claim. Founder rows count so the owner can test the live flow.
 */
export function sumEligibleDonationsByAddress(
  donations: readonly Donation[],
  gradesById: ReadonlyMap<string, ReportCardGrade>,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of donations) {
    const id = DONATION_STABLECOIN_IDS[row.asset_symbol];
    if (row.kind === "pool" || !id || !/^[AB][+-]?$/.test(gradesById.get(id) ?? "NR")) continue;
    const address = row.from_address.toLowerCase();
    totals.set(address, (totals.get(address) ?? 0) + row.usd_at_receipt);
  }
  return totals;
}

export function isEligibleDonor(
  address: string,
  totals: ReadonlyMap<string, number>,
  thresholdUsd: number,
): boolean {
  const total = totals.get(address.toLowerCase()) ?? 0;
  // Do not turn floating-point noise on an exact-threshold sum into eligibility.
  return total > thresholdUsd + 1e-9;
}
