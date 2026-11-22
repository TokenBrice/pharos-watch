// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SelectorOutput } from "@shared/lib/selector";
import { baseRecommendation, mockSelectorOutput } from "@/app/screener/picker/picker.test-support";
import { SELECTOR_STATE_DEFAULTS } from "@/lib/selector-state";
import { ResultPane } from "@/components/selector/result-pane";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("@/hooks/api-hooks", () => ({ useYieldRankings: () => ({ data: undefined }) }));
vi.mock("@/hooks/use-stablecoins", () => ({
  useSupplyHistory: () => ({ data: [], isLoading: false }),
}));

function renderEmpty(coverageWarnings: SelectorOutput["coverageWarnings"]) {
  const output: SelectorOutput = { ...mockSelectorOutput({ recommended: [] }), coverageWarnings };
  render(
    <ResultPane
      selectorResult={{ status: "ready", output }}
      input={output.input}
      state={{ ...SELECTOR_STATE_DEFAULTS, profile: output.profile, step: 4 }}
      stateProfile={output.profile}
      isMobile={false}
      onAdjust={vi.fn()}
      onStartOver={vi.fn()}
      onEditAnswer={vi.fn()}
      onRelax={vi.fn()}
      onCopyShareLink={vi.fn().mockResolvedValue(undefined)}
      tradingStaleExceeded={false}
      shareFallbackUrl={null}
      sessionRecovered={false}
    />,
  );
}

describe("ResultPane empty result", () => {
  it("keeps a real empty outcome when coins were skipped below the coverage-policy thresholds", () => {
    renderEmpty({
      sparse: false,
      uneven: false,
      skippedForCoverageCount: 1,
      skippedForCoverage: [{ id: "usdc-circle", symbol: "USDC", missingSignals: ["dewsScore"] }],
      newListingCount: 0,
      redistributionCount: 0,
    });

    expect(screen.queryByText(/Not enough eligible/)).toBeNull();
    expect(screen.getByText(/No tracked .* passes all exclusion filters/)).toBeTruthy();
    expect(screen.getByText(/This is a real outcome/)).toBeTruthy();
  });

  it("names thin peg coverage only when the engine marks the answer set sparse", () => {
    renderEmpty({
      sparse: true,
      uneven: false,
      skippedForCoverageCount: 1,
      skippedForCoverage: [{ id: "usdc-circle", symbol: "USDC", missingSignals: ["dewsScore"] }],
      newListingCount: 0,
      redistributionCount: 0,
    });

    expect(screen.getByText(/Not enough eligible/)).toBeTruthy();
  });
});

describe("ResultPane populated shortlist pipeline", () => {
  it("renders TelegramSubscribeCommand below the Shortlist and links Model in Portfolio via mergeCoinsParam", () => {
    const output: SelectorOutput = mockSelectorOutput({
      recommended: [
        {
          ...baseRecommendation,
          id: "usdc-circle",
          symbol: "USDC",
          name: "USD Coin",
          rank: 1,
          profile: "treasury",
          recommendedSource: null,
          perInputStaleness: null,
        },
        {
          ...baseRecommendation,
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          rank: 2,
          profile: "treasury",
          recommendedSource: null,
          perInputStaleness: null,
        },
      ],
    });
    render(
      <ResultPane
        selectorResult={{ status: "ready", output }}
        input={output.input}
        state={{ ...SELECTOR_STATE_DEFAULTS, profile: output.profile, step: "result" }}
        stateProfile={output.profile}
        isMobile={false}
        onAdjust={vi.fn()}
        onStartOver={vi.fn()}
        onEditAnswer={vi.fn()}
        onRelax={vi.fn()}
        onCopyShareLink={vi.fn().mockResolvedValue(undefined)}
        tradingStaleExceeded={false}
        shareFallbackUrl={null}
        sessionRecovered={false}
      />,
    );

    const portfolioLink = screen.getByRole("link", { name: /Model in Portfolio/i });
    expect(portfolioLink.getAttribute("href")).toBe("/portfolio/?coins=usdc-circle,usdt-tether");

    const shortlistSection = screen.getByRole("heading", { name: "Shortlist" }).closest("section")!;
    const telegramSection = screen.getByRole("heading", { name: /Follow this shortlist in PharosWatchBot/i }).closest("section")!;
    expect(
      shortlistSection.compareDocumentPosition(telegramSection) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
