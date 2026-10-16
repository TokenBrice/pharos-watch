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
      safetyScoreMin: "80",
      dewsMax: "20",
      pegs: "USD",
      mechanism: "cdp",
      types: "decentralized",
      lifecycle: "active",
      supplyMin: "1000000",
    });

    const params = new URLSearchParams(parsed.href.split("?")[1] ?? "");
    expect(parsed.href.startsWith("/screener/?")).toBe(true);
    expect(params.get("safetyScoreMin")).toBe("80");
    expect(params.get("dewsMax")).toBe("20");
    expect(params.get("pegs")).toBe("USD");
    expect(params.get("mechanism")).toBe("cdp");
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
});
