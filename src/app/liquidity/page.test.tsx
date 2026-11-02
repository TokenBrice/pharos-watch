// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LIQUIDITY_SCORE_WEIGHTS } from "@shared/lib/liquidity-score-weights";
import LiquidityPage from "@/app/liquidity/page";

describe("Liquidity page lead copy", () => {
  it("names only the published Liquidity Score components as score inputs", () => {
    render(<LiquidityPage />);

    const paragraph = screen.getByText(/The Liquidity Score weights/);
    const weightsSentence = paragraph.textContent?.split(".")[0]?.toLowerCase() ?? "";
    for (const { label } of LIQUIDITY_SCORE_WEIGHTS) {
      expect(weightsSentence).toContain(label.toLowerCase());
    }
    expect(weightsSentence).not.toMatch(/redemption|backstop|rails/);
  });
});
