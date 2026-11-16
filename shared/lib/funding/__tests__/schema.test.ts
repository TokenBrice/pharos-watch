import { describe, expect, it } from "vitest";
import { CostsFileSchema, DonationSchema, DonationsFileSchema } from "../schema";
import { makeDonation } from "./funding.test-support";

const DONATION = makeDonation();

describe("funding schemas", () => {
  it("accepts a valid ledger and distinguishes transaction identity by chain", () => {
    const file = {
      last_updated_at: DONATION.block_timestamp,
      donations: [makeDonation({ tx_hash: "0xAbC" }), makeDonation({ tx_hash: "0xabc", chain: "base" })],
    };
    expect(DonationsFileSchema.parse(file)).toEqual(file);
    const duplicate = DonationsFileSchema.safeParse({
      ...file,
      donations: [file.donations[0], makeDonation({ tx_hash: "0xabc" })],
    });
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) {
      expect(duplicate.error.issues.map((issue) => issue.path)).toEqual([["donations", 1, "tx_hash"]]);
    }
  });

  it("rejects mixed-case and malformed sender addresses", () => {
    expect(DonationSchema.safeParse(makeDonation({ from_address: DONATION.from_address.toUpperCase().replace("0X", "0x") })).success).toBe(false);
    expect(DonationSchema.safeParse(makeDonation({ from_address: "0xabc" })).success).toBe(false);
  });

  it("requires a lowercase token address, or null for native assets", () => {
    const native = makeDonation({ asset_symbol: "ETH", token_address: null });
    expect(DonationSchema.parse(native)).toEqual(native);
    expect(DonationSchema.safeParse(makeDonation({ token_address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" })).success).toBe(false);
    const { token_address: _omitted, ...missing } = DONATION;
    expect(DonationSchema.safeParse(missing).success).toBe(false);
  });

  it("accepts zero but rejects either negative amount independently", () => {
    const zero = makeDonation({ amount_decimal: 0, usd_at_receipt: 0 });
    expect(DonationSchema.parse(zero)).toEqual(zero);
    expect(DonationSchema.safeParse(makeDonation({ amount_decimal: -1 })).success).toBe(false);
    expect(DonationSchema.safeParse(makeDonation({ usd_at_receipt: -1 })).success).toBe(false);
  });

  it("rejects millisecond donation timestamps", () => {
    expect(() => DonationSchema.parse({
      ...DONATION,
      block_timestamp: DONATION.block_timestamp * 1000,
    })).toThrow();
  });

  it("rejects NaN donation amounts", () => {
    expect(() => DonationSchema.parse({
      ...DONATION,
      usd_at_receipt: Number.NaN,
    })).toThrow();
  });

  it("keeps cost history ordered, sponsorships at $0 and artwork self-hosted", () => {
    const costs = {
      last_reviewed_at: DONATION.block_timestamp,
      items: [{ label: "Sponsor", category: "infra", usd_per_month: 0, sponsor: { logo: "/media/s.svg", url: "https://s.example", blurb: "Thanks." } }],
      monthly_totals: [{ month: "2026-04", usd: 1709 }, { month: "2026-05", usd: 1709 }],
      one_time: [{ label: "Redesign", usd: 5800, paid_by: "founder" }],
    };
    expect(CostsFileSchema.parse(costs)).toEqual(costs);
    const reject = (patch: Record<string, unknown>) => expect(CostsFileSchema.safeParse({ ...costs, ...patch }).success).toBe(false);
    reject({ monthly_totals: [{ month: "2026-05", usd: 1 }, { month: "2026-04", usd: 1 }] });
    reject({ monthly_totals: [{ month: "2026-13", usd: 1 }] });
    reject({ items: [{ ...costs.items[0], usd_per_month: 10 }] });
    reject({ items: [{ label: "Vendor", category: "infra", usd_per_month: 5, mark: "https://cdn.example/logo.svg" }] });
  });

  it("rejects unknown chains and extra fields", () => {
    expect(() => DonationSchema.parse({ ...DONATION, chain: "not-a-chain" })).toThrow();
    expect(() => DonationSchema.parse({ ...DONATION, extra: true })).toThrow();
  });
});
