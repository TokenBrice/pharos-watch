import { describe, expect, it } from "vitest";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { HeroPassportMrzInput } from "@/lib/stablecoin-detail-mrz";
import {
  COUNTRY_MRZ_CODES,
  MECHANISM_MRZ_CODES,
  buildHeroPassportMrz,
  computeMrzCheckDigit,
} from "@/lib/stablecoin-detail-mrz";

const MRZ_LINE_PATTERN = /^[A-Z0-9<]{44}$/;

// Line 2 slot offsets: symbol 0-7, peg 7-10, grade 10-12, safety 12-15,
// peg score 15-18, liquidity 18-21, DEWS 21-24, chains 24-27, freeze 27,
// mechanism 28-33, launch 33-39, check digit 39, filler 40-44.

const FULL_INPUT: HeroPassportMrzInput = {
  name: "USD Coin",
  symbol: "USDC",
  pegCurrency: "USD",
  jurisdictionCountry: "United States",
  launchDate: "2018-09-26",
  overallGrade: "B+",
  overallScore: 76,
  pegScore: 93,
  liquidityScore: 72,
  dewsScore: 16,
  dewsBandLabel: "Watch",
  chainCount: 151,
  blacklistStatus: true,
  mechanismArchetype: "fiat-cash",
  mechanismLabel: "Custodial cash",
  url: "https://pharos.watch/stablecoin/usd-coin/",
};

function buildInput(overrides: Partial<HeroPassportMrzInput> = {}): HeroPassportMrzInput {
  return { ...FULL_INPUT, ...overrides };
}

const SPARSE_INPUT: HeroPassportMrzInput = {
  name: "Ghost Dollar",
  symbol: "GD",
  pegCurrency: "USD",
  jurisdictionCountry: null,
  launchDate: null,
  overallGrade: null,
  overallScore: null,
  pegScore: null,
  liquidityScore: null,
  dewsScore: null,
  dewsBandLabel: null,
  chainCount: 4,
  blacklistStatus: null,
  mechanismArchetype: null,
  mechanismLabel: null,
  url: "https://pharos.watch/stablecoin/ghost-dollar/",
};

describe("computeMrzCheckDigit", () => {
  it("matches the ICAO 9303 worked examples", () => {
    // 5·7 + 2·3 + 0·1 + 7·7 + 2·3 + 7·1 = 103 → 3
    expect(computeMrzCheckDigit("520727")).toBe("3");
    // Specimen document number: 147+24+9+56+27+0+14+36+3 = 316 → 6
    expect(computeMrzCheckDigit("L898902C3")).toBe("6");
    // Specimen date of birth: 49+12+0+56+3+2 = 122 → 2
    expect(computeMrzCheckDigit("740812")).toBe("2");
  });
});

describe("buildHeroPassportMrz", () => {
  it("encodes the fully populated USDC-like fixture to the exact pinned lines", () => {
    const { lines } = buildHeroPassportMrz(FULL_INPUT);

    // PW< + USA + < + USD<COIN (15 chars) + 29 fillers.
    expect(lines[0]).toBe(`PW<USA<USD<COIN${"<".repeat(29)}`);
    // USDC<<<|USD|BP|076|093|072|016|151|Y|CCASH|180926 (39 chars), then the
    // 7-3-1 check digit over those 39 chars (weighted sum 1333 → 3) + filler.
    expect(lines[1]).toBe("USDC<<<USDBP076093072016151YCCASH1809263<<<<");
  });

  it("emits two 44-char lines restricted to the MRZ charset for full and sparse data", () => {
    for (const input of [FULL_INPUT, SPARSE_INPUT, buildInput({ pegCurrency: "GOLD", overallGrade: "C-" })]) {
      const { lines } = buildHeroPassportMrz(input);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(MRZ_LINE_PATTERN);
      expect(lines[1]).toMatch(MRZ_LINE_PATTERN);
    }
  });

  it("fills every missing slot with < on a sparse coin", () => {
    const { lines } = buildHeroPassportMrz(SPARSE_INPUT);

    // PW< + XXX + < + GHOST<DOLLAR (19 chars) + 25 fillers.
    expect(lines[0]).toBe(`PW<XXX<GHOST<DOLLAR${"<".repeat(25)}`);
    // GD<<<<<|USD then 14 empty slot chars, 004 chains, N freeze, 11 empty
    // slot chars, check digit (112+39+90+28+91+4+161 = 525 → 5), filler.
    expect(lines[1]).toBe(`GD<<<<<USD${"<".repeat(14)}004N${"<".repeat(11)}5${"<".repeat(4)}`);
  });

  it("composes the sparse copyText without dangling separators", () => {
    const { copyText, ariaLabel } = buildHeroPassportMrz(SPARSE_INPUT);
    expect(copyText).toBe("GD (Ghost Dollar) — Freeze: no · 4 chains — https://pharos.watch/stablecoin/ghost-dollar/");
    expect(ariaLabel).toBe("Copy GD research summary");
  });

  it("composes the full research citation and aria label", () => {
    const { copyText, ariaLabel } = buildHeroPassportMrz(FULL_INPUT);
    expect(copyText).toBe(
      "USDC (USD Coin, launched 2018) — Pharos Safety B+ (76/100) · Peg 93 · Liquidity 72 · " +
        "DEWS 16/100 (Watch) · Custodial cash · United States jurisdiction · Freeze: yes · " +
        "151 chains — https://pharos.watch/stablecoin/usd-coin/",
    );
    expect(ariaLabel).toBe("Copy USDC research summary: Safety B+ 76 of 100, peg 93, liquidity 72, DEWS 16 of 100");
  });

  it("passes ISO currency peg codes through and maps the metal pegs", () => {
    expect(buildHeroPassportMrz(buildInput({ pegCurrency: "EUR" })).lines[1].slice(7, 10)).toBe("EUR");
    expect(buildHeroPassportMrz(buildInput({ pegCurrency: "GOLD" })).lines[1].slice(7, 10)).toBe("XAU");
    expect(buildHeroPassportMrz(buildInput({ pegCurrency: "SILVER" })).lines[1].slice(7, 10)).toBe("XAG");
    expect(buildHeroPassportMrz(buildInput({ pegCurrency: "OTHER" })).lines[1].slice(7, 10)).toBe("OTH");
  });

  it("maps grade modifiers (plain → <, minus → M)", () => {
    expect(buildHeroPassportMrz(buildInput({ overallGrade: "A" })).lines[1].slice(10, 12)).toBe("A<");
    expect(buildHeroPassportMrz(buildInput({ overallGrade: "C-" })).lines[1].slice(10, 12)).toBe("CM");
  });

  it("caps the chain slot at 999 and truncates symbols beyond 7 chars", () => {
    const { lines } = buildHeroPassportMrz(buildInput({ symbol: "LONGSYMBOL", chainCount: 1531 }));
    expect(lines[0]).toMatch(MRZ_LINE_PATTERN);
    expect(lines[1]).toMatch(MRZ_LINE_PATTERN);
    expect(lines[1].slice(0, 7)).toBe("LONGSYM");
    expect(lines[1].slice(24, 27)).toBe("999");
  });

  it("transliterates diacritics and punctuation in the name, truncating to the line", () => {
    const accented = buildHeroPassportMrz(
      buildInput({ name: "Café-Dólar (β)", jurisdictionCountry: "Switzerland" }),
    );
    expect(accented.lines[0]).toBe(`PW<CHE<CAFE<DOLAR${"<".repeat(27)}`);

    const long = buildHeroPassportMrz(buildInput({ name: "A".repeat(50) }));
    expect(long.lines[0]).toBe(`PW<USA<${"A".repeat(37)}`);
    expect(long.lines[0]).toHaveLength(44);
  });

  it("blanks the launch-date slot for malformed dates", () => {
    const { lines } = buildHeroPassportMrz(buildInput({ launchDate: "2018-9-26" }));
    expect(lines[1].slice(33, 39)).toBe("<<<<<<");
  });

  it("encodes the freeze vocabulary (Y/P/U/N) and its copyText labels", () => {
    expect(buildHeroPassportMrz(buildInput({ blacklistStatus: "possible" })).lines[1][27]).toBe("P");
    expect(buildHeroPassportMrz(buildInput({ blacklistStatus: "inherited" })).lines[1][27]).toBe("U");
    expect(buildHeroPassportMrz(buildInput({ blacklistStatus: null })).lines[1][27]).toBe("N");
    expect(buildHeroPassportMrz(buildInput({ blacklistStatus: "possible" })).copyText).toContain("Freeze: possible");
    expect(buildHeroPassportMrz(buildInput({ blacklistStatus: "inherited" })).copyText).toContain("Freeze: upstream");
  });
});

describe("COUNTRY_MRZ_CODES", () => {
  // Dual-jurisdiction display strings have no single honest alpha-3 code —
  // they deliberately fall back to XXX (ICAO "unspecified").
  const CONSCIOUSLY_UNMAPPED = new Set(["Cyprus / Lithuania"]);

  it("covers every distinct jurisdiction country in the tracked dataset (drift guard)", () => {
    const countries = new Set<string>();
    for (const coin of TRACKED_STABLECOINS) {
      if (coin.jurisdiction?.country) countries.add(coin.jurisdiction.country);
    }
    expect(countries.size).toBeGreaterThan(0);

    const unmapped = [...countries]
      .filter((country) => !(country in COUNTRY_MRZ_CODES) && !CONSCIOUSLY_UNMAPPED.has(country))
      .sort();
    expect(unmapped, `Author ISO-3166 alpha-3 MRZ codes for: ${unmapped.join(", ")}`).toEqual([]);
  });

  it("only contains 3-char A-Z codes", () => {
    for (const [country, code] of Object.entries(COUNTRY_MRZ_CODES)) {
      expect(code, `code for ${country}`).toMatch(/^[A-Z]{3}$/);
    }
  });
});

describe("MECHANISM_MRZ_CODES", () => {
  it("assigns a distinct 5-char A-Z code per archetype", () => {
    const codes = Object.values(MECHANISM_MRZ_CODES);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z]{5}$/);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });
});
