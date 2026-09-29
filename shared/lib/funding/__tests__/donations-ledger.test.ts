import { describe, expect, it } from "vitest";
import donationsAsset from "../../../data/funding/donations.json";
import { DONOR_KEY_QUALIFYING_STABLECOINS, resolveDonorKeyQualifyingStablecoin } from "../donor-eligibility";
import { DonationsFileSchema } from "../schema";

const NATIVE_ASSET_SYMBOLS = new Set(["ETH", "POL", "MATIC", "XDAI"]);
const QUALIFYING_SYMBOLS = new Set(DONOR_KEY_QUALIFYING_STABLECOINS.map((coin) => coin.symbol));

describe("committed donations ledger", () => {
  const ledger = DonationsFileSchema.parse(donationsAsset);
  const label = (row: (typeof ledger.donations)[number]) => `${row.chain}:${row.tx_hash} ${row.asset_symbol}`;

  it("records a token address on every row, null exactly for native assets", () => {
    const rawRows = (donationsAsset as { donations: Record<string, unknown>[] }).donations;
    expect(rawRows.filter((row) => !("token_address" in row)).map((row) => row.tx_hash)).toEqual([]);
    const mismatched = ledger.donations
      .filter((row) => NATIVE_ASSET_SYMBOLS.has(row.asset_symbol) !== (row.token_address === null))
      .map(label);
    expect(mismatched).toEqual([]);
  });

  it("labels a qualifying ticker only on its reviewed contract, and a reviewed contract only with its ticker", () => {
    const mislabeled = ledger.donations
      .filter((row) => {
        const resolved = resolveDonorKeyQualifyingStablecoin(row.chain, row.token_address);
        if (!resolved && !QUALIFYING_SYMBOLS.has(row.asset_symbol)) return false;
        return resolved?.symbol !== row.asset_symbol;
      })
      .map((row) => `${label(row)} @ ${row.token_address}`);
    expect(mislabeled).toEqual([]);
  });
});
