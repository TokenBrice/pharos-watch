import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LiquidityPreconditions } from "./sections/core/liquidity-overview";
import { BlacklistTrackerMethodologySection } from "./sections/monitoring/blacklist-tracker-section";

function markupHash(Component: React.ComponentType) {
  return createHash("sha256").update(renderToStaticMarkup(<Component />)).digest("hex");
}

describe("methodology preconditions", () => {
  it.each([
    ["normal", LiquidityPreconditions, "d12ba9eb026642bbba7a09b7b601f5f39a1edca07efa81a6dc9a7fcf37bae477"],
    ["compact", BlacklistTrackerMethodologySection, "f025b02aa0efbf0b0e60d3711be68f1e700f73e6e727f2aae7e85c30722cc01b"],
  ])("preserves the exact %s markup", (_name, Component, expected) => {
    expect(markupHash(Component)).toBe(expected);
  });
});
