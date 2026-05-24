import { describe, expect, it } from "vitest";
import { parsePaletteInput } from "@/lib/command-palette-verbs";

describe("parsePaletteInput", () => {
  it("builds a runnable screener URL from score and taxonomy filters", () => {
    const parsed = parsePaletteInput(
      "screen safety>=80 dews<20 peg=USD mechanism=cdp type=decentralized lifecycle=active supply>=1000000",
    );

    expect(parsed.kind).toBe("screen");
    if (parsed.kind !== "screen") return;

    expect(parsed.filters).toEqual({
      safetyPegStabilityMin: "80",
      dewsMax: "20",
      pegs: "USD",
      mechanism: "cdp",
      types: "decentralized",
      lifecycle: "active",
      supplyMin: "1000000",
    });

    const params = new URLSearchParams(parsed.href.split("?")[1] ?? "");
    expect(parsed.href.startsWith("/screener/?")).toBe(true);
    expect(params.get("safetyPegStabilityMin")).toBe("80");
    expect(params.get("dewsMax")).toBe("20");
    expect(params.get("pegs")).toBe("USD");
    expect(params.get("mechanism")).toBe("cdp");
    expect(params.get("types")).toBe("decentralized");
    expect(params.get("lifecycle")).toBe("active");
    expect(params.get("supplyMin")).toBe("1000000");
  });

  it("resolves compare tokens while preserving unresolved entries", () => {
    const parsed = parsePaletteInput("compare usdt usdt nope usdc");

    expect(parsed).toEqual({
      kind: "compare",
      coinSymbols: ["usdt", "usdt", "nope", "usdc"],
      resolvedCoinIds: ["usdt-tether", "usdc-circle"],
      unresolved: ["nope"],
    });
  });

  it("resolves pin and unpin command targets", () => {
    expect(parsePaletteInput("pin USDS")).toEqual({
      kind: "pin",
      coinSymbol: "USDS",
      resolvedCoinId: "usds-sky",
    });

    expect(parsePaletteInput("unpin all")).toEqual({
      kind: "unpin",
      coinSymbol: "all",
      resolvedCoinId: null,
    });
  });

  it("parses saved-view commands as non-runnable placeholders", () => {
    expect(parsePaletteInput("view: high quality")).toEqual({
      kind: "view",
      viewName: "high quality",
    });
  });

  it("maps tape stablecoin aliases to the timeline coin filter", () => {
    const parsed = parsePaletteInput("tape: stablecoin=usdc-circle severity=critical");

    expect(parsed).toEqual({
      kind: "tape",
      filters: {
        coin: "usdc-circle",
        severity: "critical",
      },
      href: "/timeline/?coin=usdc-circle&severity=critical",
    });
  });
});
