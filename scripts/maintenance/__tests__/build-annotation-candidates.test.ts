import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCoinIdResolver, isDirectRun } from "../build-annotation-candidates";
import type { StablecoinMeta } from "../../../shared/types";

function coin(id: string, symbol: string, name = symbol): StablecoinMeta {
  return { id, symbol, name, flags: {} } as StablecoinMeta;
}

describe("buildCoinIdResolver", () => {
  it("keeps shared labels ambiguous after later duplicate fields", () => {
    const resolveCoinId = buildCoinIdResolver([
      coin("usdx-hex-trust", "USDX", "Hex Trust USDX"),
      coin("usdx-kava", "USDX", "USDX"),
    ]);

    expect(resolveCoinId("USDX")).toBeNull();
    expect(resolveCoinId("usdx-hex-trust")).toBe("usdx-hex-trust");
    expect(resolveCoinId("usdx-kava")).toBe("usdx-kava");
  });

  it("resolves labels that belong to only one stablecoin", () => {
    const resolveCoinId = buildCoinIdResolver([coin("unique-usd", "UUSD", "Unique USD")]);

    expect(resolveCoinId(" uusd ")).toBe("unique-usd");
    expect(resolveCoinId("Unique USD")).toBe("unique-usd");
  });
});

describe("isDirectRun", () => {
  it("matches direct execution from URL-escaped checkout paths", () => {
    const argvPath = "/tmp/pharos watch checkout/scripts/maintenance/build-annotation-candidates.ts";

    expect(isDirectRun(pathToFileURL(argvPath).href, argvPath)).toBe(true);
  });

  it("rejects imports and missing argv paths", () => {
    const argvPath = "/tmp/pharos-watch/scripts/maintenance/build-annotation-candidates.ts";

    expect(isDirectRun("file:///tmp/pharos-watch/other.ts", argvPath)).toBe(false);
    expect(isDirectRun(pathToFileURL(argvPath).href, undefined)).toBe(false);
  });
});
