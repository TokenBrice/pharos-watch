import { describe, expect, it } from "vitest";
import { parsePaletteInput } from "@/lib/command-palette-verbs";
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
