import { describe, expect, it } from "vitest";
import { makeDonation as row } from "./funding.test-support";
import {
  classifyDonorKeyDonation,
  isEligibleDonor,
  resolveDonorKeyQualifyingStablecoin,
  sumEligibleDonationsByAddress,
  summarizeDonorKeyEligibility,
} from "../donor-eligibility";
import type { Donation } from "../schema";
import type { ReportCardGrade } from "../../../types/report-card-grade";

const GRADES = new Map<string, ReportCardGrade>([
  ["usdc-circle", "A"], ["usdt-tether", "A"], ["dai-makerdao", "B+"], ["usdglo-glo", "B-"],
]);

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const POOL = "0x00000000000000000000000000000000000000cc";

// Canonical Ethereum contracts, written out so the fixtures do not echo the allowlist.
const ETHEREUM_TOKEN = {
  USDC: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  USDT: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  DAI: "0x6b175474e89094c44da98b954eedeac495271d0f",
  USDGLO: "0x4f604735c1cf31399c6e711d5962b2b3e0225ad3",
  CRVUSD: "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e",
} as const;
const ETHEREUM_USDP_PAXOS = "0x8e870d67f660d95d5be530380d0ec0bd388289e1";
const ETHEREUM_USDP_PARALLEL = "0x9b3a8f7cec208e247d97dee13313690977e24459";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ARBITRUM_USDC_E = "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8";

function token(symbol: keyof typeof ETHEREUM_TOKEN, overrides: Partial<Donation> = {}): Donation {
  return row({ asset_symbol: symbol, token_address: ETHEREUM_TOKEN[symbol], ...overrides });
}

describe("donor eligibility", () => {
  it("sums reviewed stablecoins across chains, excludes pools and other assets, includes founder rows", () => {
    const totals = sumEligibleDonationsByAddress([
      row({ usd_at_receipt: 4 }),
      row({ chain: "base", tx_hash: "0x02", token_address: BASE_USDC, usd_at_receipt: 6 }),
      row({ from_address: B, tx_hash: "0x03", kind: "founder", usd_at_receipt: 10 }),
      row({ from_address: POOL, tx_hash: "0x04", kind: "pool", usd_at_receipt: 500 }),
      row({ asset_symbol: "ETH", token_address: null, usd_at_receipt: 100 }),
      row({ asset_symbol: "GIV", token_address: "0x00000000000000000000000000000000000000ee", usd_at_receipt: 100 }),
      row({ asset_symbol: "UNKNOWN", token_address: "0x00000000000000000000000000000000000000ef", usd_at_receipt: 100 }),
    ], GRADES);
    expect(totals.get(A)).toBe(10);
    expect(totals.get(B)).toBe(10);
    expect(totals.has(POOL)).toBe(false);
  });

  it("applies the threshold at the boundary and ignores address case", () => {
    const totals = sumEligibleDonationsByAddress([
      row({ usd_at_receipt: 9.99 }),
      row({ from_address: B, tx_hash: "0x02", usd_at_receipt: 0.1 }),
      row({ from_address: B, tx_hash: "0x03", usd_at_receipt: 9.9 }),
    ], GRADES);
    expect(isEligibleDonor(A, totals, 10)).toBe(false);
    expect(isEligibleDonor(B, totals, 10)).toBe(true);
    totals.set(B, 10.01);
    expect(isEligibleDonor(B.toUpperCase().replace("0X", "0x"), totals, 10)).toBe(true);
    expect(isEligibleDonor("0x0000000000000000000000000000000000000000", totals, 10)).toBe(false);
  });

  it("grants access when floating-point drift leaves an exactly-$10 sum just short", () => {
    const totals = sumEligibleDonationsByAddress(Array.from({ length: 100 }, () => row({ usd_at_receipt: 0.1 })), GRADES);
    expect(isEligibleDonor(A, totals, 10)).toBe(true);
  });

  it.each(["USDC", "USDT", "DAI", "USDGLO"] as const)("counts reconciled %s donations", (symbol) => {
    const totals = sumEligibleDonationsByAddress([token(symbol, { usd_at_receipt: 10.01 })], GRADES);
    expect(isEligibleDonor(A, totals, 10)).toBe(true);
  });

  it.each<ReportCardGrade>(["A+", "A", "A-", "B+", "B", "B-"])("counts the %s band at claim time", (grade) => {
    const totals = sumEligibleDonationsByAddress([row({ usd_at_receipt: 11 })], new Map([["usdc-circle", grade]]));
    expect(isEligibleDonor(A, totals, 10)).toBe(true);
  });

  it.each<ReportCardGrade>(["C+", "C", "C-", "D", "F", "NR"])("excludes %s even above the donation threshold", (grade) => {
    const totals = sumEligibleDonationsByAddress([row({ usd_at_receipt: 100 })], new Map([["usdc-circle", grade]]));
    expect(isEligibleDonor(A, totals, 10)).toBe(false);
  });

  it("fails closed for absent grades and sums only qualifying portions of mixed donations", () => {
    const donations = [row({ usd_at_receipt: 6 }), token("DAI", { usd_at_receipt: 100 })];
    expect(sumEligibleDonationsByAddress(donations, new Map()).size).toBe(0);
    const totals = sumEligibleDonationsByAddress(donations, new Map([["usdc-circle", "A"], ["dai-makerdao", "C"]]));
    expect(totals.get(A)).toBe(6);
    expect(isEligibleDonor(A, totals, 10)).toBe(false);
  });
});

describe("donor key contract resolution", () => {
  const grades = new Map<string, ReportCardGrade>([["usdc-circle", "A"], ["usdp-paxos", "A"]]);

  it("does not count a USDP-labelled row on Parallel's USDp contract", () => {
    const parallel = row({ asset_symbol: "USDP", token_address: ETHEREUM_USDP_PARALLEL, usd_at_receipt: 50 });
    expect(classifyDonorKeyDonation(parallel, grades)).toMatchObject({ status: "not-qualifying", stablecoin: null });
    expect(sumEligibleDonationsByAddress([parallel], grades).size).toBe(0);
  });

  it("counts the Paxos USDP contract as USDP whatever the ledger label says", () => {
    const paxos = row({ asset_symbol: "USDP.OLD", token_address: ETHEREUM_USDP_PAXOS, usd_at_receipt: 10 });
    expect(classifyDonorKeyDonation(paxos, grades)).toMatchObject({
      status: "counted",
      stablecoin: { symbol: "USDP", stablecoinId: "usdp-paxos" },
    });
    expect(summarizeDonorKeyEligibility(A, [paxos], grades).countedAssets).toEqual(["USDP"]);
  });

  it("does not count a USDC-labelled row on an unreviewed contract such as bridged USDC.e", () => {
    const bridged = row({ chain: "arbitrum", asset_symbol: "USDC", token_address: ARBITRUM_USDC_E, usd_at_receipt: 50 });
    expect(classifyDonorKeyDonation(bridged, grades).status).toBe("not-qualifying");
  });

  it("scopes a contract to its chain", () => {
    // The Ethereum USDC address on Base is not Base USDC.
    expect(resolveDonorKeyQualifyingStablecoin("base", ETHEREUM_TOKEN.USDC)).toBeNull();
    expect(resolveDonorKeyQualifyingStablecoin("base", BASE_USDC)?.stablecoinId).toBe("usdc-circle");
  });

  it("never counts a null token address, even with a qualifying label", () => {
    expect(resolveDonorKeyQualifyingStablecoin("ethereum", null)).toBeNull();
    expect(classifyDonorKeyDonation(row({ token_address: null, usd_at_receipt: 50 }), grades).status).toBe("not-qualifying");
  });

  it("matches contracts case-insensitively", () => {
    expect(resolveDonorKeyQualifyingStablecoin("ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")?.symbol).toBe("USDC");
    expect(classifyDonorKeyDonation(row({ token_address: ETHEREUM_TOKEN.USDC.toUpperCase().replace("0X", "0x") }), grades).status)
      .toBe("counted");
  });
});

describe("donor key donation classification", () => {
  it("separates pool, non-qualifying, out-of-band, and unavailable grades", () => {
    const grades = new Map<string, ReportCardGrade>([["usdc-circle", "A-"], ["dai-makerdao", "NR"], ["usdt-tether", "C"]]);
    expect(classifyDonorKeyDonation(row({ kind: "pool" }), grades).status).toBe("pool");
    expect(classifyDonorKeyDonation(row({ asset_symbol: "ETH", token_address: null }), grades).status).toBe("not-qualifying");
    expect(classifyDonorKeyDonation(
      row({ asset_symbol: "constructor", token_address: "0x00000000000000000000000000000000000000ee" }),
      grades,
    ).status).toBe("not-qualifying");
    expect(classifyDonorKeyDonation(token("USDT"), grades).status).toBe("grade-outside-band");
    expect(classifyDonorKeyDonation(token("DAI"), grades).status).toBe("grade-outside-band");
    expect(classifyDonorKeyDonation(token("CRVUSD"), grades)).toMatchObject({
      status: "grade-unavailable",
      grade: null,
      stablecoin: { label: "crvUSD", stablecoinId: "crvusd-curve" },
    });
    expect(classifyDonorKeyDonation(row(), grades)).toMatchObject({ status: "counted", grade: "A-" });
  });

  it("summarizes one address's counted USD and assets and ignores other senders", () => {
    const donations = [
      row({ usd_at_receipt: 6 }),
      token("DAI", { tx_hash: "0x02", usd_at_receipt: 4 }),
      row({ tx_hash: "0x03", asset_symbol: "ETH", token_address: null, usd_at_receipt: 50 }),
      row({ tx_hash: "0x04", from_address: B, usd_at_receipt: 100 }),
    ];
    const summary = summarizeDonorKeyEligibility(A.toUpperCase().replace("0X", "0x"), donations, GRADES);
    expect(summary.qualifyingUsd).toBe(10);
    expect(summary.countedAssets).toEqual(["USDC", "DAI"]);
    expect(summary.rows.map((entry) => entry.status)).toEqual(["counted", "counted", "not-qualifying"]);
    expect(summarizeDonorKeyEligibility(POOL, donations, GRADES)).toMatchObject({ qualifyingUsd: 0, countedAssets: [], rows: [] });
  });
});
