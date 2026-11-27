import { describe, expect, it } from "vitest";
import { buildPortfolioHrefFromCoinIds, parsePaletteInput } from "@/lib/command-palette-verbs";
import { COMMAND_PALETTE_STABLECOINS } from "@/lib/command-palette-search-data";
import { SCREENER_URL_SCHEMA } from "@/lib/screener-filters";
import { decodeState } from "@/lib/url-state";

describe("parsePaletteInput", () => {
  it("builds a runnable screener URL from score and taxonomy filters", () => {
    const parsed = parsePaletteInput(
      "screen safety>=80 dews<20 peg=USD mechanism=cdp type=decentralized lifecycle=active supply>=1000000",
    );

    expect(parsed.kind).toBe("screen");
    if (parsed.kind !== "screen") return;

    expect(parsed.filters).toEqual({
      safetyScoreMin: "80",
      dewsMax: "20",
      pegs: "USD",
      mechanisms: "cdp",
      types: "decentralized",
      lifecycle: "active",
      supplyMin: "1000000",
    });

    const params = new URLSearchParams(parsed.href.split("?")[1] ?? "");
    expect(parsed.href.startsWith("/screener/?")).toBe(true);
    expect(params.get("safetyScoreMin")).toBe("80");
    expect(params.get("dewsMax")).toBe("20");
    expect(params.get("pegs")).toBe("USD");
    expect(params.get("mechanisms")).toBe("cdp");
    expect(params.get("types")).toBe("decentralized");
    expect(params.get("lifecycle")).toBe("active");
    expect(params.get("supplyMin")).toBe("1000000");
  });

  it("keeps a positive supply ceiling and drops one the screener would read as no maximum", () => {
    const positive = parsePaletteInput("screen supply<=1000000");
    const zero = parsePaletteInput("screen lifecycle=active supply<=0");

    expect(positive.kind === "screen" && positive.filters).toEqual({ supplyMax: "1000000" });
    expect(zero.kind === "screen" && zero.filters).toEqual({ lifecycle: "active" });
  });

  it.each([
    ["safety>=80 safety>=90", "safetyScoreMin", 90],
    ["safety>=90 safety>=80", "safetyScoreMin", 90],
    ["safety>=80 safety>=80", "safetyScoreMin", 80],
    ["dews>=20 dews>=40 dews<=80", "dewsMin", 40],
    ["dews<=80 dews<=20", "dewsMax", 20],
    ["dews<=20 dews<=20", "dewsMax", 20],
    ["supply>=100 supply>=200 supply<=500", "supplyMin", 200],
    ["supply<=500 supply<=300", "supplyMax", 300],
    ["supply<=500 supply<=500", "supplyMax", 500],
  ])("conjoins repeated scalar bounds: %s", (input, key, expected) => {
    const parsed = parsePaletteInput(`screen ${input}`);
    if (parsed.kind !== "screen") throw new Error("expected screen");
    expect(parsed.error).toBeUndefined();
    const decoded = decodeState(parsed.href.split("?")[1] ?? "", SCREENER_URL_SCHEMA);
    expect(decoded[key as keyof typeof decoded]).toBe(expected);
    expect(parsed.filters[key]).toBe(String(expected));
  });

  it("accumulates and deduplicates only admitted enum-list values", () => {
    const parsed = parsePaletteInput("screen peg=USD peg=EUR peg=USD mechanism=cdp mechanism=fiat-cash type=invalid");
    if (parsed.kind !== "screen") throw new Error("expected screen");
    const decoded = decodeState(parsed.href.split("?")[1] ?? "", SCREENER_URL_SCHEMA);
    expect(decoded.pegs).toEqual(["USD", "EUR"]);
    expect(decoded.mechanisms).toEqual(["cdp", "fiat-cash"]);
    expect(decoded.lifecycle).toEqual(["active"]);
    expect(parsed.filters).toEqual({ pegs: ["USD", "EUR"], mechanisms: ["cdp", "fiat-cash"], lifecycle: "active" });
  });

  it.each(["dews>=80 dews<=20", "supply>=200 supply<=100", "safety>=110"])(
    "marks contradictory or unrepresentable scalar input non-runnable: %s", (input) => {
      const parsed = parsePaletteInput(`screen ${input}`);
      if (parsed.kind !== "screen") throw new Error("expected screen");
      expect(parsed.error).toBeTruthy();
    },
  );
});

const SUPPRESSED_STATUSES = new Set(["frozen", "quarantined", "delisted"]);
const SUPPRESSED_IDS = COMMAND_PALETTE_STABLECOINS
  .filter(([, , , status]) => SUPPRESSED_STATUSES.has(status ?? ""))
  .map(([id]) => id ?? "");

describe("palette verb coin resolution", () => {
  it.each(SUPPRESSED_IDS)("resolves a suppressed coin's exact id to that coin: %s", (id) => {
    const unpin = parsePaletteInput(`unpin ${id}`);
    expect(unpin.kind === "unpin" && unpin.resolvedCoinId).toBe(id);
    const pin = parsePaletteInput(`pin ${id}`);
    // Exact ids are unique, so the verb either names this coin or refuses.
    expect(pin.kind === "pin" && (pin.resolvedCoinId === id || pin.resolvedCoinId === null)).toBe(true);
  });

  it("never resolves a ticker several coins own to one of them by suppression order", () => {
    const owners = new Map<string, Set<string>>();
    for (const [id, , symbol] of COMMAND_PALETTE_STABLECOINS) {
      const ticker = symbol.toLowerCase();
      owners.set(ticker, (owners.get(ticker) ?? new Set()).add(id));
    }
    const ambiguous = [...owners.entries()].filter(([, ids]) => ids.size > 1);
    expect(ambiguous.length).toBeGreaterThan(0);
    for (const [ticker, ids] of ambiguous) {
      const parsed = parsePaletteInput(`pin ${ticker}`);
      if (parsed.kind !== "pin") throw new Error("expected pin");
      expect(parsed.resolvedCoinId === null || ids.has(parsed.resolvedCoinId), ticker).toBe(true);
    }
    const usdh = parsePaletteInput("pin usdh");
    // Native Markets' USDH is frozen; the live namesakes must not absorb the verb.
    expect(usdh.kind === "pin" && usdh.resolvedCoinId).toBeNull();
  });

  it("keeps a uniquely owned ticker resolvable", () => {
    const parsed = parsePaletteInput("pin usdc");
    expect(parsed.kind === "pin" && parsed.resolvedCoinId).toBe("usdc-circle");
  });

  it("parses the portfolio verb and routes through mergeCoinsParam", () => {
    const parsed = parsePaletteInput("portfolio USDC usds-sky");
    expect(parsed.kind).toBe("portfolio");
    if (parsed.kind !== "portfolio") return;
    expect(parsed.resolvedCoinIds).toEqual(["usdc-circle", "usds-sky"]);
    expect(parsed.href).toBe("/portfolio/?coins=usdc-circle,usds-sky");

    expect(buildPortfolioHrefFromCoinIds(["usds-sky"], "usdc-circle:10000")).toBe(
      "/portfolio/?p=usdc-circle%3A10000%2Cusds-sky%3A0",
    );
  });

  it.each([
    ["usdc reserves", "/stablecoin/usdc-circle/#reserves", "Reserves"],
    ["reserves usdc", "/stablecoin/usdc-circle/#reserves", "Reserves"],
    ["usdc liquidity", "/stablecoin/usdc-circle/#liquidity", "Liquidity"],
    ["usdc history", "/stablecoin/usdc-circle/#history", "History"],
    ["depeg usdc", "/stablecoin/usdc-circle/#history", "Depeg history"],
    ["usdc freeze", "/stablecoin/usdc-circle/#freeze-seizure", "Freeze & Seizure"],
    ["freezes usdc", "/stablecoin/usdc-circle/#freeze-seizure", "Freeze & Seizure"],
    ["usdc blacklist", "/stablecoin/usdc-circle/#blacklist", "Blacklist Events"],
    ["blacklist usdc", "/stablecoin/usdc-circle/#blacklist", "Blacklist Events"],
    ["dai blacklist", "/stablecoin/dai-makerdao/#freeze-seizure", "Freeze & Seizure"],
  ])("resolves deep section intent %s -> %s (%s)", (input, expectedHref, expectedLabel) => {
    const parsed = parsePaletteInput(input);
    expect(parsed.kind).toBe("section");
    if (parsed.kind !== "section") return;
    expect(parsed.href).toBe(expectedHref);
    expect(parsed.sectionLabel).toBe(expectedLabel);
  });

  it("keeps bare section keywords as normal page searches while trailing space prompts for a ticker", () => {
    expect(parsePaletteInput("depeg")).toEqual({ kind: "none" });
    expect(parsePaletteInput("reserves")).toEqual({ kind: "none" });
    expect(parsePaletteInput("liquidity")).toEqual({ kind: "none" });
    expect(parsePaletteInput("freeze")).toEqual({ kind: "none" });
    expect(parsePaletteInput("blacklist")).toEqual({ kind: "none" });

    const prompt = parsePaletteInput("reserves ");
    expect(prompt.kind).toBe("section");
    if (prompt.kind === "section") {
      expect(prompt.resolvedCoinId).toBeNull();
    }

    const blacklistPrompt = parsePaletteInput("blacklist ");
    expect(blacklistPrompt.kind).toBe("section");
    if (blacklistPrompt.kind === "section") {
      expect(blacklistPrompt.resolvedCoinId).toBeNull();
      expect(blacklistPrompt.sectionLabel).toBe("Blacklist Events");
    }
  });
});
