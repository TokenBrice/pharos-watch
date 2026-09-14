import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { adaptOndoOusgPortfolio, fetchOndoOusgReserves } from "../ondo-ousg";
import { fetchChainlinkNavCore } from "../chainlink-nav-core";
import { fetchTextWithRetry } from "../helpers";

vi.mock("../chainlink-nav-core", () => ({ fetchChainlinkNavCore: vi.fn() }));
vi.mock("../helpers", async (importOriginal) => ({
  ...await importOriginal<typeof import("../helpers")>(),
  fetchTextWithRetry: vi.fn(),
}));

const html = readFileSync(new URL("./fixtures/ondo-ousg-portfolio.html", import.meta.url), "utf8");
const NOW = Date.parse("2026-09-14T12:00:00Z") / 1000;
const adapt = (source = html) => adaptOndoOusgPortfolio(source, NOW);

describe("Ondo OUSG dated portfolio", () => {
  it("replays the seven issuer positions with stable identities, linked collateral and explicit other assets", () => {
    const result = adapt();
    expect(result.slices).toHaveLength(7);
    expect(result.slices.map((slice) => slice.pct)).toEqual([
      150997834.85, 101629548.21, 49420454.61, 30688840.23, 6231226.41, 105398.11, 100000,
    ].map((value) => value / 339173302.4200001 * 100));
    expect(result.slices.reduce((total, slice) => total + slice.pct, 0)).toBeCloseTo(100, 10);
    expect(result.slices.filter((slice) => slice.coinId).map((slice) => slice.coinId)).toEqual([
      "buidl-blackrock", "benji-franklin-templeton", "usdc-circle",
    ]);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.parse("2026-09-11T20:00:00Z") / 1000,
      freshnessMode: "verified",
      totalReserveUsd: 339173302.4200001,
      unknownExposurePct: 105398.11 / 339173302.4200001 * 100,
      details: { compositionEvidence: "issuer-reported-portfolio" },
    });
  });

  it.each([
    ["changed scope", html.replace("excludes OUSG", "includes OUSG")],
    ["missing", html.replace('portfolio', 'absent')],
    ["duplicate document", html + html],
    ["unreviewed identity", html.replace('592c34b5-6d5d-43f9-a4b8-787ab0b88bce', 'unknown')],
    ["duplicate holding", html.replaceAll('012efdd9-0b06-48e7-96d6-4a7f2a588850', '07110012-2936-43db-a82c-b486e74e3822')],
    ["changed symbol", html.replace('SWEEP', 'UNKNOWN')],
    ["negative amount", html.replace('150997834.85', '-150997834.85')],
    ["nonfinite amount", html.replace('150997834.85', '1e999')],
    ["unreconciled total", html.replace('339173302.4200001', '339173303.42')],
    ["stale", html.replace('2026-09-11T20:00:00.000Z', '2026-08-11T20:00:00.000Z')],
    ["future", html.replace('2026-09-11T20:00:00.000Z', '2026-09-15T20:00:00.000Z')],
    ["invalid date", html.replace('2026-09-11T20:00:00.000Z', 'not-a-date')],
  ])("fails closed for %s", (_label, source) => {
    expect(() => adapt(source)).toThrow();
  });

  it("preserves genuine zero holdings without manufacturing positive exposure", () => {
    const result = adapt(html.replace('150997834.85', '0').replace('339173302.4200001', '188175467.57'));
    expect(result.slices).toHaveLength(6);
    expect(result.slices.some((slice) => slice.name.includes('Sweep'))).toBe(false);
    expect(result.slices.reduce((total, slice) => total + slice.pct, 0)).toBeCloseTo(100);
  });

  it("retains NAV and redemption telemetry, replaces the source date, and removes only the obsolete NAV warning", async () => {
    vi.mocked(fetchTextWithRetry).mockResolvedValue(html);
    vi.mocked(fetchChainlinkNavCore).mockResolvedValue({
      slices: [{ name: "NAV envelope", pct: 100, risk: "low" }],
      warnings: [
        { code: "nav-portfolio-composition-unverified", message: "portfolio", severity: "warning", effect: "degraded" },
        { code: "other-warning", message: "retain", severity: "info", effect: "info" },
      ],
      metadata: { sourceTimestamp: NOW, navPerToken: "113", redemption: { capacityUsd: 123 }, details: { nav: true } },
    });
    const result = await fetchOndoOusgReserves({} as StablecoinMeta, {} as LiveReservesConfig, new AbortController().signal, { nowSec: NOW });
    expect(result.warnings?.map((warning) => warning.code)).toEqual(["other-warning"]);
    expect(result.metadata).toMatchObject({ navPerToken: "113", redemption: { capacityUsd: 123 }, details: { nav: true } });
    expect(result.metadata?.sourceTimestamp).not.toBe(NOW);
  });
});
