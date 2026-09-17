import { describe, expect, it } from "vitest";
import { buildTweetText } from "../twitter-digest-text";

describe("buildTweetText", () => {
  it("preserves an existing non-selected cashtag", () => {
    expect(buildTweetText(
      "",
      "$USDT liquidity held while USDC demand rose.",
      null,
      null,
      { coins: ["USDC"] },
    )).toBe("$USDT liquidity held while $USDC demand rose.");
  });
});
