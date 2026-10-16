import { describe, expect, it } from "vitest";
import { parseUsdInput } from "./model";
import { mergeCoinsParam } from "@/lib/portfolio-codec";

describe("portfolio page model", () => {
  it("parses supported USD input formats", () => {
    expect(parseUsdInput("$1,234.50")).toBe(1234.5);
    expect(parseUsdInput("2500")).toBe(2500);
    expect(parseUsdInput("12abc")).toBe(0);
  });

  it("merges the shared coins param as zero-amount holdings without overriding amounts", () => {
    expect(mergeCoinsParam("usdt-tether:25000", "usdt-tether,usds-sky")).toBe("usdt-tether:25000,usds-sky:0");
    expect(mergeCoinsParam("", "usdc-circle")).toBe("usdc-circle:0");
    expect(mergeCoinsParam("usdc-circle:5", "")).toBe("usdc-circle:5");
    expect(mergeCoinsParam("", "")).toBe("");
  });
});
