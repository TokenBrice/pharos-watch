// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportCardDetail } from "@/components/report-card";
import { makeReportCard as makeReportCardFixture } from "@/test/fixtures/safety-scores";
import { createReportCardRawInputs } from "@shared/lib/report-card-raw-inputs";
import type { ReportCard } from "@shared/types";

vi.mock("@/components/radar-chart", () => ({
  ReportCardRadar: ({ size }: { size?: number }) => <div data-testid="report-card-radar" data-size={size} />,
}));

function makeReportCard(): ReportCard {
  return makeReportCardFixture({
    id: "test-usd",
    name: "Test USD",
    symbol: "TUSD",
    overallGrade: "B",
    overallScore: 75,
    baseScore: 78,
    ratedDimensions: 5,
    isDefunct: false,
    dimensions: {
      pegStability: {
        grade: "A",
        score: 95,
        detail: "Stable peg.",
      },
      liquidity: {
        grade: "B",
        score: 72,
        detail: "Observed liquidity.",
      },
      resilience: {
        grade: "B-",
        score: 68,
        detail: "Collateral: Reserve assets (20). Custody: institutional (-5). Blacklist: possible (-10)",
      },
      decentralization: {
        grade: "C",
        score: 55,
        detail: "Governance: single entity (-10)",
      },
      dependencyRisk: {
        grade: "A",
        score: 90,
        detail: "Exposure: none (0)",
      },
    },
    rawInputs: createReportCardRawInputs({
      pegScore: 95,
      liquidityScore: 72,
      collateralQuality: "rwa",
      governanceQuality: "regulated-entity",
      custodyModel: "institutional-regulated",
    }),
  });
}

describe("ReportCardDetail", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("marks the header freshness chip stale after the report-card freshness budget", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-19T12:16:00Z"));

    render(
      <ReportCardDetail
        card={makeReportCard()}
        liquidityComponents={null}
        updatedAtMs={new Date("2026-06-19T12:00:00Z").getTime()}
      />,
    );

    expect(screen.getByRole("status", { name: /Updated at/i }).getAttribute("data-stale")).toBe("true");
  });

  it("keeps dimension disclosure controls separate from methodology hint buttons", () => {
    const { container } = render(<ReportCardDetail card={makeReportCard()} liquidityComponents={null} />);

    expect(container.querySelector("button button")).toBeNull();
    expect(screen.getByRole("button", { name: "Hide Exit Liquidity details" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show Resilience details" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Explain Resilience" }).length).toBeGreaterThan(0);
  });

  it("opens exit liquidity details by default", () => {
    render(<ReportCardDetail card={makeReportCard()} liquidityComponents={null} />);

    expect(screen.getByRole("button", { name: "Hide Exit Liquidity details" })).toBeTruthy();
    expect(screen.getByText("DEX Liquidity")).toBeTruthy();
    expect(screen.getByText("72 / 100")).toBeTruthy();
  });

  it("expands dimension details from the disclosure control", () => {
    render(<ReportCardDetail card={makeReportCard()} liquidityComponents={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Show Resilience details" }));

    expect(screen.getByRole("button", { name: "Hide Resilience details" })).toBeTruthy();
    expect(screen.getByText("Collateral:")).toBeTruthy();
    expect(screen.getByText("Reserve assets")).toBeTruthy();
  });

  it("surfaces the parent-cap note separately from peg drag", () => {
    render(
      <ReportCardDetail
        card={{
          ...makeReportCard(),
          overallScore: 72,
          overallCapped: true,
          uncappedOverallScore: 79,
          rawInputs: createReportCardRawInputs({
            pegScore: 95,
            liquidityScore: 72,
            variantParentId: "usds-sky",
            variantKind: "savings-passthrough",
          }),
        }}
        liquidityComponents={null}
      />,
    );

    expect(screen.getByText("Overall capped at parent stablecoin")).toBeTruthy();
    expect(screen.getByText(/Parent cap:/)).toBeTruthy();
    expect(screen.queryByText(/Peg:/)).toBeNull();
  });

  it("renders no radar on the detail card (Figma coin template)", () => {
    render(
      <ReportCardDetail
        card={makeReportCard()}
        liquidityComponents={null}
        rightColumn={<div data-testid="reserves-panel">Reserves</div>}
      />,
    );

    // The coin-template safety card is a flat hairline row list; the radar
    // visualization lives on compare surfaces only.
    expect(screen.queryByTestId("report-card-radar")).toBeNull();
  });

  it("shows reviewed oracle setup inside decentralization details", () => {
    render(
      <ReportCardDetail
        card={{
          ...makeReportCard(),
          oracleRisk: {
            tier: "medianized-with-delay",
            score: 85,
            label: "Medianized feeds with delay",
            summary: "Parent CDP collateral prices use delayed medianized oracle feeds.",
            reviewedAt: "2026-06-12",
            reviewer: "Codex data review",
            confidence: "verified",
            sources: [{ label: "Oracle docs", url: "https://example.com/oracles" }],
            inheritedFrom: { id: "usds-sky", name: "USDS", symbol: "USDS" },
            selectedBranch: null,
            branches: [
              {
                id: "eth",
                label: "ETH collateral",
                tier: "medianized-with-delay",
                score: 85,
                summary: "ETH branch uses the delayed medianized feed path.",
                collateralAssets: ["ETH"],
              },
            ],
          },
        }}
        liquidityComponents={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show Decentralization details" }));

    expect(screen.getByText("Oracle setup")).toBeTruthy();
    expect(screen.getByText("Medianized feeds with delay")).toBeTruthy();
    expect(screen.getByText("Parent CDP collateral prices use delayed medianized oracle feeds.")).toBeTruthy();
    expect(screen.getByText(/inherited from/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "USDS" }).getAttribute("href")).toBe("/stablecoin/usds-sky");
    expect(screen.getByRole("link", { name: "Oracle docs" }).getAttribute("href")).toBe("https://example.com/oracles");
    expect(screen.getByText(/ETH collateral/)).toBeTruthy();
  });

  it("shows reviewed bridge-route risk inside decentralization details", () => {
    render(
      <ReportCardDetail
        card={{
          ...makeReportCard(),
          bridgeRouteRisk: {
            tier: "external-lock-mint",
            score: 40,
            label: "External lock/mint bridge",
            summary: "Destination supply depends on an external lockbox route.",
            reviewedAt: "2026-06-12",
            reviewer: "Codex L2BEAT route review",
            confidence: "verified",
            protocols: [
              {
                name: "Chainlink CCIP",
                slug: "ccip",
                source: "l2beat",
                bridgeTypes: ["lockAndMint", "burnAndMint"],
              },
            ],
            sources: [{ label: "CCIP on L2BEAT", url: "https://l2beat.com/interop/protocols/ccip" }],
          },
        }}
        liquidityComponents={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show Decentralization details" }));

    expect(screen.getByText("Bridge route")).toBeTruthy();
    expect(screen.getByText("External lock/mint bridge")).toBeTruthy();
    expect(screen.getByText("Destination supply depends on an external lockbox route.")).toBeTruthy();
    expect(screen.getByText(/Chainlink CCIP/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "CCIP on L2BEAT" }).getAttribute("href")).toBe(
      "https://l2beat.com/interop/protocols/ccip",
    );
  });
});
