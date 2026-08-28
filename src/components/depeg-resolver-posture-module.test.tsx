// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DepegResolverPostureModule } from "@/components/depeg-resolver-posture-module";
import { DDR_METHODOLOGY_VERSION, DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/depeg-resolver";
import {
  type DdrResponse,
  type DdrV2ResponseRow,
} from "@shared/types/depeg-resolver";
import { DDR_TEST_META, makeDdrResponseRow } from "./depeg-resolver-test-support";

vi.mock("@/lib/feature-flags", () => ({
  isDepegResolverEnabled: () => true,
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: () => <span data-testid="logo" />,
}));

const meta = DDR_TEST_META;

function response(rows: DdrV2ResponseRow[]): DdrResponse {
  return {
    _meta: meta,
    rows,
    methodology: {
      version: DDR_METHODOLOGY_VERSION,
      versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      changelogPath: "/methodology/depeg-resolver-changelog/",
      asOf: 1,
      isCurrent: true,
    },
  };
}

const THREE_ROWS: DdrV2ResponseRow[] = [
  makeDdrResponseRow({ stablecoinId: "a-coin", symbol: "ACOIN", tier: "recovery_likely" }),
  makeDdrResponseRow({ stablecoinId: "b-coin", symbol: "BCOIN", tier: "at_risk" }),
  makeDdrResponseRow({ stablecoinId: "c-coin", symbol: "CCOIN", tier: "recovery_unlikely" }),
];

describe("DepegResolverPostureModule", () => {
  it("stays hidden below the aggregate threshold so the per-event cards carry small books", () => {
    const { container } = render(<DepegResolverPostureModule data={response(THREE_ROWS.slice(0, 2))} />);
    expect(container.firstChild).toBeNull();
  });

  it("stays hidden while data loads", () => {
    const { container } = render(<DepegResolverPostureModule data={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("stays hidden for hard-degraded snapshots", () => {
    const { container } = render(
      <DepegResolverPostureModule
        data={{ ...response(THREE_ROWS), _meta: { ...meta, degraded: true, degradedReason: "missing-cache" } }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("summarizes the book posture and groups every tier", () => {
    render(<DepegResolverPostureModule data={response(THREE_ROWS)} />);

    expect(screen.getByLabelText("Depeg outlook posture")).toBeTruthy();
    expect(screen.getByText(/1 likely to recover, 1 at risk, 1 unlikely to return/)).toBeTruthy();
    expect(screen.getByText("Recovery Likely")).toBeTruthy();
    expect(screen.getByText("Recovery Unlikely")).toBeTruthy();
  });

  it("flags an event whose live gap is wider than its recorded peak as deepening", () => {
    const rows = [
      ...THREE_ROWS,
      makeDdrResponseRow({
        stablecoinId: "d-coin",
        symbol: "DCOIN",
        tier: "at_risk",
        sourceOverrides: {
          peakDeviationBps: -400,
          currentDeviationBps: -900,
        },
      }),
    ];
    render(<DepegResolverPostureModule data={response(rows)} />);

    expect(screen.getByText("DCOIN is deepening past its worst.")).toBeTruthy();
    expect(screen.getByText("deepening")).toBeTruthy();
  });

  it("shows an expected-clearing band for benchmarked events", () => {
    const rows = [
      ...THREE_ROWS,
      makeDdrResponseRow({
        stablecoinId: "e-coin",
        symbol: "ECOIN",
        tier: "at_risk",
        sourceOverrides: {
          duration: {
            suppressed: false,
            suppressedReason: null,
            stratum: "below · moderate · USD",
            medianSec: 86_400,
            iqrSec: [43_200, 172_800],
            ageStatus: "ordinary",
            horizons: [],
          },
        },
      }),
    ];
    render(<DepegResolverPostureModule data={response(rows)} />);

    expect(screen.getByText("~1d")).toBeTruthy();
  });
});
