// @vitest-environment jsdom
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LighthouseA11yLedger } from "./lighthouse-a11y-ledger";
import {
  fixtureChains,
  fixtureStability,
  fixtureStress,
  fixtureStablecoins,
  fixtureMetaById,
} from "./__fixtures__/scene-data";
import { buildSceneData } from "./systems/scene-data";

afterEach(() => cleanup());

describe("LighthouseA11yLedger", () => {
  const scene = buildSceneData({
    chains: fixtureChains,
    stability: fixtureStability,
    stress: fixtureStress,
    stablecoins: fixtureStablecoins,
    metaById: fixtureMetaById,
  });

  it("renders an sr-only section", () => {
    const { container } = render(<LighthouseA11yLedger scene={scene} />);
    expect(container.querySelector(".sr-only")).toBeTruthy();
  });

  it("includes the beam state", () => {
    render(<LighthouseA11yLedger scene={scene} />);
    expect(screen.getByText(/beam/i)).toBeTruthy();
    expect(screen.getByText(/STEADY/i)).toBeTruthy();
  });

  it("enumerates each harbor with chain name and coin count", () => {
    render(<LighthouseA11yLedger scene={scene} />);
    expect(screen.getByText(/Ethereum/)).toBeTruthy();
    expect(screen.getByText(/Tron/)).toBeTruthy();
  });

  it("enumerates each boat by symbol and classification", () => {
    render(<LighthouseA11yLedger scene={scene} />);
    expect(screen.getAllByText(/USDT|USDC|DAI/).length).toBeGreaterThan(0);
  });

  it("includes the highest sea state", () => {
    render(<LighthouseA11yLedger scene={scene} />);
    expect(screen.getByText(/sea state/i)).toBeTruthy();
  });
});
