import type { Donation } from "./schema";

/**
 * Sums receipt-date USD per lowercase sender across every ledger row except
 * `pool` rows: pool senders are payout contracts (for example Giveth) and can
 * never sign a claim. Founder rows count so the owner can test the live flow.
 */
export function sumEligibleDonationsByAddress(donations: readonly Donation[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of donations) {
    if (row.kind === "pool") continue;
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
  // Cents are summed as floats; tolerate representation error at the boundary.
  return total + 1e-9 >= thresholdUsd;
}
