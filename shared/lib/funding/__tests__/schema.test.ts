import { describe, expect, it } from "vitest";
import { DonationSchema } from "../schema";

const DONATION = {
  chain: "ethereum",
  tx_hash: "0xabc",
  block_timestamp: 1_774_000_000,
  from_address: "0xsender",
  display: "sender.eth",
  kind: "community",
  asset_symbol: "USDC",
  amount_decimal: 10,
  usd_at_receipt: 10,
  price_note: "stablecoin-1-to-1",
} as const;

describe("funding schemas", () => {
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
