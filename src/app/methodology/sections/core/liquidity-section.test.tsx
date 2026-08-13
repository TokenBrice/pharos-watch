import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LiquidityMethodologySection } from "./liquidity-section";

describe("LiquidityMethodologySection", () => {
  it("preserves the rendered methodology content", () => {
    const markup = renderToStaticMarkup(<LiquidityMethodologySection />);
    const markupHash = createHash("sha256").update(markup).digest("hex");

    expect(markupHash).toBe("128bc8d7486c10de2ee259e4163fdbfc9d4ddd3d2e5fde82d75288ce4c71e598");
  });
});
