import { describe, expect, it } from "vitest";
import { assertDonationCreditContinuity, CostsFileSchema, DonationSchema, DonationsFileSchema, TransferDonationsFileSchema } from "../schema";
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

  it("distinguishes log receipts and requires evidence for the original receipt before adding a sibling", () => {
    const tx_hash = `0x${"ab".repeat(32)}`;
    const first = makeDonation({ tx_hash, transfer_discriminator: "log:0", legacy_credit: true });
    const second = makeDonation({ tx_hash, transfer_discriminator: "log:7" });
    const file = { last_updated_at: DONATION.block_timestamp, donations: [first, second] };
    expect(TransferDonationsFileSchema.parse(file)).toEqual(file);
    expect(DonationsFileSchema.safeParse(file).success).toBe(false);
    expect(TransferDonationsFileSchema.safeParse({
      ...file, donations: [first, { ...second, tx_hash: `0x${"AB".repeat(32)}`, transfer_discriminator: "log:0" }],
    }).success).toBe(false);
    expect(TransferDonationsFileSchema.safeParse({
      ...file, donations: [makeDonation({ tx_hash }), second],
    }).success).toBe(false);
  });

  it("requires the original transaction credit on the matching typed transfer across releases", () => {
    const tx_hash = `0x${"ab".repeat(32)}`;
    const old = makeDonation({ tx_hash, amount_decimal: 5, usd_at_receipt: 5 });
    const base = { last_updated_at: old.block_timestamp, donations: [old] };
    const original = { ...old, transfer_discriminator: "log:3" };
    const sibling = { ...original, transfer_discriminator: "log:4", token_address: `0x${"12".repeat(20)}` };
    const ledger = (rows: typeof base.donations) => TransferDonationsFileSchema.parse({ ...base, donations: rows });
    expect(() => assertDonationCreditContinuity(base, ledger([original, sibling]))).toThrow("exact published transfer");
    expect(() => assertDonationCreditContinuity(base, ledger([original, { ...sibling, legacy_credit: true }]))).toThrow();
    const converted = ledger([{ ...original, legacy_credit: true }, sibling]);
    expect(() => assertDonationCreditContinuity(base, converted)).not.toThrow();
    expect(() => assertDonationCreditContinuity(converted, ledger([original, { ...original, transfer_discriminator: "log:4", legacy_credit: true }]))).toThrow();
  });

  it.each([
    ["log:0", false, true], ["native", true, true], ["trace:0.2", true, true],
    ["log:0", true, false], ["native", false, false], ["log:01", false, false],
  ] as const)("validates the canonical %s discriminator for a native=%s receipt", (transfer_discriminator, native, valid) => {
    expect(DonationSchema.safeParse(makeDonation({
      tx_hash: `0x${"ab".repeat(32)}`, transfer_discriminator,
      token_address: native ? null : DONATION.token_address,
    })).success).toBe(valid);
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
    const item = { label: "S", category: "infra", usd_per_month: 0, sponsor: { logo: "/media/s.svg", url: "https://s.example", blurb: "Thanks." } };
    const costs = { last_reviewed_at: DONATION.block_timestamp, items: [item], monthly_totals: [{ month: "2026-04", usd: 1 }, { month: "2026-05", usd: 1 }], one_time: [] };
    expect(CostsFileSchema.parse(costs)).toEqual(costs);
    for (const patch of [
      { monthly_totals: [...costs.monthly_totals].reverse() },
      { monthly_totals: [{ month: "2026-13", usd: 1 }] },
      { items: [{ ...item, usd_per_month: 10 }] },
      { items: [{ label: "V", category: "infra", usd_per_month: 5, mark: "https://cdn.example/v.svg" }] },
    ]) expect(CostsFileSchema.safeParse({ ...costs, ...patch }).success).toBe(false);
  });

  it("rejects unknown chains and extra fields", () => {
    expect(() => DonationSchema.parse({ ...DONATION, chain: "not-a-chain" })).toThrow();
    expect(() => DonationSchema.parse({ ...DONATION, extra: true })).toThrow();
  });
});
