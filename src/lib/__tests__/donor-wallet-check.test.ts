import { describe, expect, it } from "vitest";
import type { Donation } from "@shared/lib/funding/schema";
import type { ReportCardGrade } from "@shared/types/report-card-grade";
import { checkDonorWallet, donorKeyGradesFromResponse, resolveDonorWalletGrades } from "@/lib/donor-wallet-check";

const DONOR = "0x00000000000000000000000000000000000000aa";
const GIVETH_POOL = "0x00000000000000000000000000000000000000bb";

// Ethereum token contracts for the symbols these fixtures use; ETH is native.
const ETHEREUM_TOKEN: Record<string, string | null> = {
  USDC: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  USDT: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  DAI: "0x6b175474e89094c44da98b954eedeac495271d0f",
  USDGLO: "0x4f604735c1cf31399c6e711d5962b2b3e0225ad3",
  ETH: null,
};

let txCounter = 0;
function donation(overrides: Partial<Donation> & { asset_symbol: string }): Donation {
  txCounter += 1;
  return {
    chain: "ethereum",
    tx_hash: `0x${txCounter.toString(16).padStart(64, "0")}`,
    block_timestamp: 1_780_000_000,
    from_address: DONOR,
    display: "donor",
    kind: "community",
    token_address: ETHEREUM_TOKEN[overrides.asset_symbol] ?? null,
    amount_decimal: 1,
    usd_at_receipt: 1,
    price_note: "stablecoin-par",
    ...overrides,
  };
}

const GRADES = new Map<string, ReportCardGrade>([
  ["usdc-circle", "A"],
  ["usdt-tether", "B-"],
  ["usdglo-glo", "C"],
]);

describe("donor wallet check", () => {
  it("treats exactly the threshold as eligible and a cent under as short, matching the address in any case", () => {
    const ledger = [
      donation({ asset_symbol: "USDC", usd_at_receipt: 6 }),
      donation({ asset_symbol: "USDT", usd_at_receipt: 4 }),
    ];
    const upper = `0x${DONOR.slice(2).toUpperCase()}`;

    expect(checkDonorWallet(upper, ledger, GRADES)).toMatchObject({ verdict: "eligible", qualifyingUsd: 10 });

    const under = [donation({ asset_symbol: "USDC", usd_at_receipt: 9.99 })];
    expect(checkDonorWallet(DONOR, under, GRADES).verdict).toBe("short");
  });

  it("never counts pool rows, out-of-band grades or unlisted tokens", () => {
    const ledger = [
      donation({ from_address: GIVETH_POOL, kind: "pool", asset_symbol: "USDC", usd_at_receipt: 50 }),
      donation({ asset_symbol: "USDGLO", usd_at_receipt: 20 }),
      donation({ asset_symbol: "ETH", usd_at_receipt: 30 }),
    ];

    expect(checkDonorWallet(GIVETH_POOL, ledger, GRADES)).toMatchObject({
      verdict: "short",
      qualifyingUsd: 0,
      rows: [{ status: "pool" }],
    });
    expect(checkDonorWallet(DONOR, ledger, GRADES).rows.map((row) => row.status)).toEqual([
      "grade-outside-band",
      "not-qualifying",
    ]);
  });

  it("reports unconfirmed, never short, when missing grades could reach the threshold or grades are unavailable", () => {
    const ledger = [
      donation({ asset_symbol: "USDC", usd_at_receipt: 4 }),
      donation({ asset_symbol: "DAI", usd_at_receipt: 6 }),
    ];

    expect(checkDonorWallet(DONOR, ledger, GRADES)).toMatchObject({ verdict: "unconfirmed", qualifyingUsd: 4 });
    expect(checkDonorWallet(DONOR, [donation({ asset_symbol: "ETH", usd_at_receipt: 1 })], null).verdict).toBe(
      "unconfirmed",
    );
    expect(checkDonorWallet(DONOR, [], null).verdict).toBe("no-donations");
  });

  const RESPONSE = {
    model: "v9" as const,
    methodologyVersion: "9.0",
    asOfSec: 1_780_000_000,
    updatedAt: 1_780_000_000,
    publicationStatus: "current" as const,
    grades: [{ id: "usdc-circle", score: 90, grade: "A" as const }],
  };

  it("drops grades from a held publication", () => {
    expect(donorKeyGradesFromResponse({ ...RESPONSE, publicationStatus: "held" })).toBeNull();
    expect(donorKeyGradesFromResponse(RESPONSE)?.get("usdc-circle")).toBe("A");
  });

  it("stops confirming eligibility when a refetch fails after an earlier success", () => {
    const ledger = [donation({ asset_symbol: "USDC", usd_at_receipt: 25 })];
    const loaded = resolveDonorWalletGrades({ data: RESPONSE, isError: false, isLoading: false });
    expect(loaded.state).toBe("ready");
    expect(checkDonorWallet(DONOR, ledger, loaded.gradesById).verdict).toBe("eligible");

    // TanStack Query keeps the last `data` when a refetch errors.
    const refetchFailed = resolveDonorWalletGrades({ data: RESPONSE, isError: true, isLoading: false });
    expect(refetchFailed).toEqual({ state: "unavailable", gradesById: null });
    expect(checkDonorWallet(DONOR, ledger, refetchFailed.gradesById)).toMatchObject({
      verdict: "unconfirmed",
      qualifyingUsd: 0,
    });
  });
});
