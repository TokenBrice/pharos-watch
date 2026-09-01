import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LiquidityMethodologySection } from "./liquidity-section";

describe("LiquidityMethodologySection", () => {
  it("preserves the rendered methodology content", () => {
    const markup = renderToStaticMarkup(<LiquidityMethodologySection />);
    const markupHash = createHash("sha256").update(markup).digest("hex");

    expect(markupHash).toBe("ef3650d6332726563fafdf9123c893800d5154df746ed1eb127e97a1575f6fea");
  });
});
