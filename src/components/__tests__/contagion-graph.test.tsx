// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReportCard, ReportCardGrade, ReportCardsResponse } from "@shared/types";

vi.mock("@/lib/contagion-layout", async () => {
  const actual = await vi.importActual<typeof import("@/lib/contagion-layout")>("@/lib/contagion-layout");

  return {
    ...actual,
    runSimulation: () =>
      new Map([
        ["usde-ethena", { x: 220, y: 300 }],
        ["usdtb-ethena", { x: 320, y: 300 }],
        ["usdc-circle", { x: 440, y: 300 }],
        ["dai-makerdao", { x: 560, y: 300 }],
      ]),
  };
});

const { ContagionGraph } = await import("@/components/contagion-graph");

const DIMENSION_STUB = {
  grade: "B" as ReportCardGrade,
  score: 70,
  detail: "",
};

const RAW_INPUTS_STUB = {
  pegScore: 95,
  activeDepeg: false,
  depegEventCount: 0,
  lastEventAt: null,
  liquidityScore: 60,
  effectiveExitScore: null,
  redemptionBackstopScore: null,
  redemptionRouteFamily: null,
  redemptionImmediateCapacityUsd: null,
  redemptionImmediateCapacityRatio: null,
  concentrationHhi: null,
  bluechipGrade: null,
  canBeBlacklisted: false as const,
  chainTier: "ethereum" as const,
  deploymentModel: "native-multichain" as const,
  collateralQuality: "rwa" as const,
  custodyModel: "institutional-regulated" as const,
  governanceTier: "centralized" as const,
  governanceQuality: "regulated-entity" as const,
  dependencies: [],
  navToken: false,
};

function makeCard(id: string, symbol: string, grade: ReportCardGrade = "B"): ReportCard {
  return {
    id,
    name: symbol,
    symbol,
    overallGrade: grade,
    overallScore: 70,
    baseScore: 70,
    ratedDimensions: 5,
    dimensions: {
      pegStability: DIMENSION_STUB,
      liquidity: DIMENSION_STUB,
      resilience: DIMENSION_STUB,
      decentralization: DIMENSION_STUB,
      dependencyRisk: DIMENSION_STUB,
    },
    rawInputs: RAW_INPUTS_STUB,
    isDefunct: false,
  };
}

const CARDS = [
  makeCard("usde-ethena", "USDe", "A"),
  makeCard("usdtb-ethena", "USDTB", "B"),
  makeCard("usdc-circle", "USDC", "A"),
  makeCard("dai-makerdao", "DAI", "A"),
];

const MCAP_MAP = new Map([
  ["usde-ethena", 5_000_000_000],
  ["usdtb-ethena", 2_000_000_000],
  ["usdc-circle", 60_000_000_000],
  ["dai-makerdao", 4_000_000_000],
]);

const DEPENDENCY_EDGES: ReportCardsResponse["dependencyGraph"]["edges"] = [
  { from: "usdtb-ethena", to: "usde-ethena", weight: 0.6, type: "wrapper" },
  { from: "usde-ethena", to: "usdc-circle", weight: 0.8, type: "collateral" },
  { from: "dai-makerdao", to: "usdc-circle", weight: 0.4, type: "mechanism" },
];

beforeAll(() => {
  Object.defineProperty(SVGSVGElement.prototype, "createSVGPoint", {
    configurable: true,
    value() {
      const point = {
        x: 0,
        y: 0,
        matrixTransform() {
          return { x: point.x, y: point.y };
        },
      };
      return point;
    },
  });

  Object.defineProperty(SVGSVGElement.prototype, "getScreenCTM", {
    configurable: true,
    value() {
      return {
        inverse() {
          return null;
        },
      };
    },
  });
});

afterEach(() => {
  cleanup();
});

describe("ContagionGraph", () => {
  it("supports keyboard neighborhood focus and directional node navigation", () => {
    render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />);

    fireEvent.click(screen.getByRole("radio", { name: "Selected neighborhood" }));

    const nodePicker = screen.getByLabelText("Coin") as HTMLSelectElement;
    const usdcNode = screen.getByRole("button", { name: /USDC/i });
    usdcNode.focus();

    fireEvent.keyDown(usdcNode, { key: "Enter" });
    expect(nodePicker.value).toBe("usdc-circle");

    fireEvent.keyDown(usdcNode, { key: "ArrowLeft" });
    expect((document.activeElement as HTMLElement | null)?.getAttribute("data-node-id")).toBe("usde-ethena");
  });

  it("lets clicks retarget the selected neighborhood", () => {
    render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />);

    fireEvent.click(screen.getByRole("radio", { name: "Selected neighborhood" }));

    const nodePicker = screen.getByLabelText("Coin") as HTMLSelectElement;
    fireEvent.click(screen.getByRole("button", { name: /USDe/i }));

    expect(nodePicker.value).toBe("usde-ethena");
  });

  it("shows an edge tooltip on edge hover", async () => {
    const { container } = render(
      <ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />,
    );

    const edgeHitArea = container.querySelectorAll('svg line[stroke="transparent"]')[0];
    expect(edgeHitArea).not.toBeNull();

    fireEvent.mouseEnter(edgeHitArea!);

    await waitFor(() => {
      expect(container.textContent).toContain("USDTB");
      expect(container.textContent).toContain("wrapper dependency");
    });
  });

  it("reduces visible nodes in neighborhood mode for connected subsets", () => {
    render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />);

    fireEvent.click(screen.getByRole("radio", { name: "Selected neighborhood" }));
    fireEvent.click(screen.getByRole("button", { name: /USDe/i }));

    expect(screen.getByText(/Showing 3 of 4 dependency-linked stablecoins with 2 visible edges\./)).toBeTruthy();
  });
});
