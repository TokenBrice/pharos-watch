import type { Donation } from "@shared/lib/funding/schema";

export function makeDonation(overrides: Partial<Donation> = {}): Donation {
  return {
    chain: "ethereum",
    tx_hash: "0x01",
    block_timestamp: 1_774_000_000,
    from_address: "0x00000000000000000000000000000000000000aa",
    display: "sender.eth",
    kind: "community",
    asset_symbol: "USDC",
    amount_decimal: 1,
    usd_at_receipt: 1,
    price_note: "stablecoin-1-to-1",
    ...overrides,
  };
}
