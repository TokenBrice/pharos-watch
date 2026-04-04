// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TreasuryStableExposureTable } from "@/components/treasury-stable-exposure-table";
import type { TreasuryStableExposureResponse } from "@shared/types";

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <div>{name}</div>,
}));

function makeResponse(): TreasuryStableExposureResponse {
  return {
    entities: [
      {
        protocolId: "alpha",
        slug: "alpha",
        name: "Alpha DAO",
        category: "DAO treasury",
        source: "defillama-github",
        adapterFile: "alpha.js",
        chains: ["ethereum"],
        directWalletUsd: 10_000_000,
        treasuryUsd: 10_000_000,
        stablecoinSleeveUsd: 2_000_000,
        trackedStableUsd: 1_900_000,
        decentralizedStableUsd: 1_200_000,
        decentralizedStablePctOfTreasury: 12,
        decentralizedStablePctOfStableSleeve: 60,
        weightedSafetyScore: 78,
        weightedSafetyGrade: "B+",
        governanceBuckets: {
          centralizedUsd: 700_000,
          centralizedDependentUsd: 0,
          decentralizedUsd: 1_200_000,
        },
        holdings: [],
        coverage: {
          extractionMode: "static-seeded",
          ownerCount: 1,
          ownerChainCount: 1,
          denominatorStatus: "direct-only",
          directWalletUsd: 10_000_000,
          defiPositionUsd: 0,
          consumedDirectBalanceUsd: 0,
          trackedStableUsd: 1_900_000,
          stablecoinSleeveUsd: 2_000_000,
          untrackedStableUsd: 100_000,
          derivedUntrackedStableUsd: 0,
          ratedTrackedStableUsd: 1_900_000,
          trackedStablePctOfTreasury: 19,
          trackedStablePctOfStableSleeve: 95,
          ratedTrackedStablePct: 100,
          untrackedStableCount: 1,
          derivedUntrackedStableCount: 0,
          skippedDerivedPositionCount: 0,
          notes: [],
        },
      },
      {
        protocolId: "beta",
        slug: "beta",
        name: "Beta Labs",
        category: "Protocol treasury",
        source: "defillama-github",
        adapterFile: "beta.js",
        chains: ["ethereum"],
        directWalletUsd: 4_000_000,
        treasuryUsd: null,
        stablecoinSleeveUsd: 800_000,
        trackedStableUsd: 800_000,
        decentralizedStableUsd: 300_000,
        decentralizedStablePctOfTreasury: null,
        decentralizedStablePctOfStableSleeve: 37.5,
        weightedSafetyScore: 91,
        weightedSafetyGrade: "A-",
        governanceBuckets: {
          centralizedUsd: 500_000,
          centralizedDependentUsd: 0,
          decentralizedUsd: 300_000,
        },
        holdings: [],
        coverage: {
          extractionMode: "static-seeded",
          ownerCount: 1,
          ownerChainCount: 1,
          denominatorStatus: "partial",
          directWalletUsd: 4_000_000,
          defiPositionUsd: 300_000,
          consumedDirectBalanceUsd: 100_000,
          trackedStableUsd: 800_000,
          stablecoinSleeveUsd: 800_000,
          untrackedStableUsd: 0,
          derivedUntrackedStableUsd: 25_000,
          ratedTrackedStableUsd: 800_000,
          trackedStablePctOfTreasury: null,
          trackedStablePctOfStableSleeve: 100,
          ratedTrackedStablePct: 100,
          untrackedStableCount: 0,
          derivedUntrackedStableCount: 1,
          skippedDerivedPositionCount: 1,
          notes: ["Treasury-relative metrics are unavailable because one or more derived positions could not be valued end to end."],
        },
      },
    ],
    updatedAt: 1_743_337_200,
    coverage: {
      entityCount: 2,
      registryCount: 3,
      launchEligibleCount: 2,
      ownerChainTuples: 5,
      launchOwnerChainTuples: 2,
      comparableEntityCount: 1,
      partialEntityCount: 1,
      invalidEntityCount: 0,
      supplementedEntityCount: 1,
      evmOnly: true,
      extractionModes: {
        staticSeeded: 3,
        customReviewed: 0,
        dynamicUnresolved: 0,
        missing: 0,
      },
    },
  };
}

describe("TreasuryStableExposureTable", () => {
  it("sorts by decentralized stable dollars by default and responds to sort changes", () => {
    render(<TreasuryStableExposureTable data={makeResponse()} logos={{}} />);

    let rowButtons = screen.getAllByRole("button", { expanded: false });
    expect(rowButtons[0]?.textContent).toContain("Alpha DAO");
    expect(rowButtons[1]?.textContent).toContain("Beta Labs");

    fireEvent.change(screen.getByLabelText("Sort by"), {
      target: { value: "weightedSafetyScore" },
    });

    rowButtons = screen.getAllByRole("button", { expanded: false });
    expect(rowButtons[0]?.textContent).toContain("Beta Labs");
    expect(rowButtons[1]?.textContent).toContain("Alpha DAO");
  });

  it("surfaces partial rows as sleeve-only and excludes them from treasury-share summary counts", () => {
    render(<TreasuryStableExposureTable data={makeResponse()} logos={{}} />);

    expect(screen.getAllByText(/1 treasury-comparable rows and 1 partial or invalid rows/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Partial denominator").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1 comparable entities currently show at least 5% decentralized stable exposure/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("N/A").length).toBeGreaterThan(0);
  });
});
