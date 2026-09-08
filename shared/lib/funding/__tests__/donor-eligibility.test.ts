import { describe, expect, it } from "vitest";
import { makeDonation as row } from "./funding.test-support";
import { isEligibleDonor, sumEligibleDonationsByAddress } from "../donor-eligibility";
import type { ReportCardGrade } from "../../../types/report-card-grade";

const GRADES = new Map<string, ReportCardGrade>([
  ["usdc-circle", "A"], ["usdt-tether", "A"], ["dai-makerdao", "B+"], ["usdglo-glo", "B-"],
]);

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const POOL = "0x00000000000000000000000000000000000000cc";


describe("donor eligibility", () => {
  it("sums reviewed stablecoins across chains, excludes pools and other assets, includes founder rows", () => {
    const totals = sumEligibleDonationsByAddress([
      row({ usd_at_receipt: 4 }),
      row({ chain: "base", tx_hash: "0x02", usd_at_receipt: 6 }),
      row({ from_address: B, tx_hash: "0x03", kind: "founder", usd_at_receipt: 10 }),
      row({ from_address: POOL, tx_hash: "0x04", kind: "pool", usd_at_receipt: 500 }),
      row({ asset_symbol: "ETH", usd_at_receipt: 100 }),
      row({ asset_symbol: "GIV", usd_at_receipt: 100 }),
      row({ asset_symbol: "UNKNOWN", usd_at_receipt: 100 }),
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
    expect(isEligibleDonor(B, totals, 10)).toBe(false);
    totals.set(B, 10.01);
    expect(isEligibleDonor(B.toUpperCase().replace("0X", "0x"), totals, 10)).toBe(true);
    expect(isEligibleDonor("0x0000000000000000000000000000000000000000", totals, 10)).toBe(false);
  });

  it("does not grant access for floating-point noise at exactly $10", () => {
    const totals = sumEligibleDonationsByAddress(Array.from({ length: 100 }, () => row({ usd_at_receipt: 0.1 })), GRADES);
    expect(isEligibleDonor(A, totals, 10)).toBe(false);
  });

  it.each(["USDC", "USDT", "DAI", "USDGLO"])("counts reconciled %s donations", (asset_symbol) => {
    const totals = sumEligibleDonationsByAddress([row({ asset_symbol, usd_at_receipt: 10.01 })], GRADES);
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
    const donations = [row({ usd_at_receipt: 6 }), row({ asset_symbol: "DAI", usd_at_receipt: 100 })];
    expect(sumEligibleDonationsByAddress(donations, new Map()).size).toBe(0);
    const totals = sumEligibleDonationsByAddress(donations, new Map([["usdc-circle", "A"], ["dai-makerdao", "C"]]));
    expect(totals.get(A)).toBe(6);
    expect(isEligibleDonor(A, totals, 10)).toBe(false);
  });
});
