import { describe, expect, it } from "vitest";
import type { DonorKeyQualifyingStablecoin } from "@shared/lib/funding/donor-eligibility";
import type { ReportCardGrade } from "@shared/types/report-card-grade";
import {
  buildDonorKeyQualifyingCoins,
  summarizeCountingCoinNames,
  type DonorKeyGradeLookup,
} from "@/lib/donor-key-qualifying-coins";

function allowlist(labels: readonly string[]): DonorKeyQualifyingStablecoin[] {
  return labels.map((label) => ({ symbol: label.toUpperCase(), label, stablecoinId: `${label.toLowerCase()}-issuer`, contracts: {} }));
}

function lookupFrom(gradesByLabel: Readonly<Record<string, ReportCardGrade>>): DonorKeyGradeLookup {
  return (stablecoinId) => {
    const grade = gradesByLabel[stablecoinId.replace(/-issuer$/, "")];
    return grade ? { grade, score: 70 } : null;
  };
}

describe("donor key qualifying coins", () => {
  it("counts A and B bands with modifiers, keeps other grades outside the band, and marks missing grades unavailable, in list order", () => {
    const grades: Record<string, ReportCardGrade> = {
      zeta: "B-",
      alpha: "C+",
      mid: "A+",
      nr: "NR",
      bee: "B+",
      dee: "D",
      eff: "F",
      aye: "A-",
      cee: "C",
    };
    const labels = ["zeta", "alpha", "missing", "mid", "nr", "bee", "dee", "eff", "aye", "cee"];

    const coins = buildDonorKeyQualifyingCoins(allowlist(labels), lookupFrom(grades));

    expect(coins.map((coin) => [coin.label, coin.grade, coin.status])).toEqual([
      ["zeta", "B-", "counts"],
      ["alpha", "C+", "outside-band"],
      ["missing", null, "unavailable"],
      ["mid", "A+", "counts"],
      ["nr", "NR", "outside-band"],
      ["bee", "B+", "counts"],
      ["dee", "D", "outside-band"],
      ["eff", "F", "outside-band"],
      ["aye", "A-", "counts"],
      ["cee", "C", "outside-band"],
    ]);
    expect(coins[2]).toMatchObject({ stablecoinId: "missing-issuer", score: null });
    expect(summarizeCountingCoinNames(coins)).toBe("zeta, mid, bee, and aye");
  });

  it("lists every counting coin up to five, then the first three and the remainder", () => {
    const six = ["one", "two", "three", "four", "five", "six"];
    const gradedA = lookupFrom(Object.fromEntries(six.map((label): [string, ReportCardGrade] => [label, "A"])));

    const withFiveCounting = buildDonorKeyQualifyingCoins(allowlist([...six.slice(0, 5), "gap"]), gradedA);
    expect(summarizeCountingCoinNames(withFiveCounting)).toBe("one, two, three, four, and five");

    const withSixCounting = buildDonorKeyQualifyingCoins(allowlist(six), gradedA);
    expect(summarizeCountingCoinNames(withSixCounting)).toBe("one, two, three, and 3 more");
  });
});
