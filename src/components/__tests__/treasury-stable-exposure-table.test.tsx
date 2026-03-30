// @vitest-environment jsdom

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
          trackedStableUsd: 1_900_000,
          stablecoinSleeveUsd: 2_000_000,
          untrackedStableUsd: 100_000,
          ratedTrackedStableUsd: 1_900_000,
          trackedStablePctOfTreasury: 19,
          trackedStablePctOfStableSleeve: 95,
          ratedTrackedStablePct: 100,
          untrackedStableCount: 1,
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
        treasuryUsd: 4_000_000,
        stablecoinSleeveUsd: 800_000,
        trackedStableUsd: 800_000,
        decentralizedStableUsd: 300_000,
        decentralizedStablePctOfTreasury: 7.5,
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
          trackedStableUsd: 800_000,
          stablecoinSleeveUsd: 800_000,
          untrackedStableUsd: 0,
          ratedTrackedStableUsd: 800_000,
          trackedStablePctOfTreasury: 20,
          trackedStablePctOfStableSleeve: 100,
          ratedTrackedStablePct: 100,
          untrackedStableCount: 0,
          notes: [],
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
});
