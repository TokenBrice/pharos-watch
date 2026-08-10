import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LiquidityMethodologySection } from "./liquidity-section";

describe("LiquidityMethodologySection", () => {
  it("preserves the rendered methodology content", () => {
    const markup = renderToStaticMarkup(<LiquidityMethodologySection />);
    const markupHash = createHash("sha256").update(markup).digest("hex");

    expect(markupHash).toBe("02a73c4bddb297d59ffdb8c1f55ab0216d8e10791f3d6f57d839a05105d60239");
  });
});
