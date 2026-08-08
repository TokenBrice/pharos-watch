import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LiquidityMethodologySection } from "./liquidity-section";

describe("LiquidityMethodologySection", () => {
  it("preserves the rendered methodology content", () => {
    const markup = renderToStaticMarkup(<LiquidityMethodologySection />);
    const markupHash = createHash("sha256").update(markup).digest("hex");

    expect(markupHash).toBe("1dad8d28fe60b404b7f0f87e63080013abf03e348c4fda354bf995bb6d231b37");
  });
});
