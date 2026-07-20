import { describe, expect, it } from "vitest";
import { cgSimplePricePath } from "../coingecko";

describe("cgSimplePricePath", () => {
  it("forces full precision without dropping existing parameters", () => {
    const path = cgSimplePricePath("ids=euro-coin&vs_currencies=eur&precision=2");
    const url = new URL(path, "https://api.coingecko.com");

    expect(url.pathname).toBe("/simple/price");
    expect(url.searchParams.get("ids")).toBe("euro-coin");
    expect(url.searchParams.get("vs_currencies")).toBe("eur");
    expect(url.searchParams.get("precision")).toBe("full");
  });
});
