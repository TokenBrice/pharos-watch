import { describe, expect, it } from "vitest";
import { DonationsFileSchema, type Donation } from "../schema";
import { isEligibleDonor, sumEligibleDonationsByAddress } from "../donor-eligibility";
import donationsAsset from "../../../data/funding/donations.json";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const POOL = "0x00000000000000000000000000000000000000cc";

function row(overrides: Partial<Donation>): Donation {
  return {
    chain: "ethereum",
    tx_hash: "0x01",
    block_timestamp: 1_774_000_000,
    from_address: A,
    display: "a.eth",
    kind: "community",
    asset_symbol: "USDC",
    amount_decimal: 1,
    usd_at_receipt: 1,
    price_note: "stablecoin-1-to-1",
    ...overrides,
  };
}

describe("donor eligibility", () => {
  it("sums across rows and chains, excludes pool rows, includes founder rows", () => {
    const totals = sumEligibleDonationsByAddress([
      row({ usd_at_receipt: 4 }),
      row({ chain: "base", tx_hash: "0x02", usd_at_receipt: 6 }),
      row({ from_address: B, tx_hash: "0x03", kind: "founder", usd_at_receipt: 10 }),
      row({ from_address: POOL, tx_hash: "0x04", kind: "pool", usd_at_receipt: 500 }),
    ]);
    expect(totals.get(A)).toBe(10);
    expect(totals.get(B)).toBe(10);
    expect(totals.has(POOL)).toBe(false);
  });

  it("applies the threshold at the boundary and ignores address case", () => {
    const totals = sumEligibleDonationsByAddress([
      row({ usd_at_receipt: 9.99 }),
      row({ from_address: B, tx_hash: "0x02", usd_at_receipt: 0.1 }),
      row({ from_address: B, tx_hash: "0x03", usd_at_receipt: 9.9 }),
    ]);
    expect(isEligibleDonor(A, totals, 10)).toBe(false);
    expect(isEligibleDonor(B, totals, 10)).toBe(true);
    expect(isEligibleDonor(B.toUpperCase().replace("0X", "0x"), totals, 10)).toBe(true);
    expect(isEligibleDonor("0x0000000000000000000000000000000000000000", totals, 10)).toBe(false);
  });

  it("finds eligible wallets in the committed ledger", () => {
    const file = DonationsFileSchema.parse(donationsAsset);
    const totals = sumEligibleDonationsByAddress(file.donations);
    const eligible = [...totals.entries()].filter(([, usd]) => usd >= 10);
    expect(eligible.length).toBeGreaterThan(0);
  });
});
