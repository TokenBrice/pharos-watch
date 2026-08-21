import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LiquidityMethodologySection } from "./liquidity-section";

describe("LiquidityMethodologySection", () => {
  it("preserves the rendered methodology content", () => {
    const markup = renderToStaticMarkup(<LiquidityMethodologySection />);
    const markupHash = createHash("sha256").update(markup).digest("hex");

    expect(markupHash).toBe("c70957a796c437f617af8ce0110c5a6aeddebb8c0143e28661e7c7a35e7b299f");
  });
});
