import { describe, expect, it } from "vitest";
import { DonationSchema, DonationsFileSchema } from "../schema";
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

  it("rejects unknown chains and extra fields", () => {
    expect(() => DonationSchema.parse({ ...DONATION, chain: "not-a-chain" })).toThrow();
    expect(() => DonationSchema.parse({ ...DONATION, extra: true })).toThrow();
  });
});
