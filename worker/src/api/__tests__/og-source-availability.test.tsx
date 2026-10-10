import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import satoriStandalone from "satori/standalone";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { handleOg, resetOgWasmInitializationForTests } from "../og";
import { DepegCard, type DepegCardData } from "../../lib/og-templates/depeg-card";
import { loadStressSignalCurrentRows } from "../../lib/stress-signals-current-rows";
import type { ReactElement } from "react";

vi.mock("satori/standalone", () => ({ init: vi.fn(), default: vi.fn(async () => "<svg></svg>") }));
vi.mock("../../lib/stress-signals-current-rows", () => ({
  loadStressSignalCurrentRows: vi.fn(), loadStressSignalCurrentRowForCoin: vi.fn(),
}));

afterEach(() => {
  resetOgWasmInitializationForTests();
  vi.clearAllMocks();
});

describe("depeg OG independent source availability", () => {
  it.each([false, true])("does not manufacture DEWS zeroes from absent rows; observed=%s", async (observed) => {
    const now = Math.floor(Date.now() / 1000);
    vi.mocked(loadStressSignalCurrentRows).mockResolvedValue({ results: observed ? [{
      stablecoin_id: "usdt-tether", score: 0, band: "CALM", signals_json: "{}", computed_at: now,
    }] : [] });
    const db = mockD1([
      { match: "FROM cache WHERE key = ?", rows: [], first: null },
      { match: "stability_index_samples", rows: [], first: null },
      { match: "peak_deviation_bps", rows: [] },
      { match: "ended_at IS NOT NULL", rows: [] },
      { match: "COUNT(*) as count", rows: [], first: observed ? { count: 0 } : null },
    ]);
    const response = await handleOg(db, "/api/og/depeg");
    expect(response?.status).toBe(200);
    const calls = vi.mocked(satoriStandalone).mock.calls;
    const element = calls[calls.length - 1][0] as ReactElement<{ data: DepegCardData }>;
    expect(element.type).toBe(DepegCard);
    expect(element.props.data.dewsDistribution).toEqual(observed ? { danger: 0, alert: 0, warning: 0, normal: 1 } : null);
    expect(element.props.data.newToday).toBe(observed ? 0 : null);
    const markup = renderToStaticMarkup(element);
    if (observed) expect(markup).not.toContain("DEWS source unavailable");
    else expect(markup).toContain("DEWS source unavailable");
  });
});
