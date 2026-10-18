import { describe, expect, it, vi } from "vitest";
import { readGa4Rows, routeFamily, summarizeVitals } from "../analyze-web-vitals.mjs";

function row(value: string, id: string, { event = "web_vital", path = "/", name = "LCP", surface = "(not set)" } = {}) {
  return { dimensionValues: [event, path, name, value, id, surface, "navigate"].map((value) => ({ value })) };
}

describe("GA4 web vitals analysis", () => {
  it("uses nearest-rank p75 per metric identity, retaining the worst cumulative update", () => {
    const groups = summarizeVitals([row("100", "a"), row("150", "a"), row("200", "b"), row("300", "c"), row("400", "d")]);
    expect(groups).toEqual([{ family: "home", metric: "LCP", navigation: "navigate", samples: 4, p75: 300, budget: 2500, overBudget: false }]);
  });
  it("keeps readiness surfaces and route families distinct and preserves explicit CLS zero", () => {
    const groups = summarizeVitals([
      row("0", "cls", { name: "CLS" }),
      row("12000", "ready", { event: "fresh_data_ready", path: "/stablecoin/usdt-tether/", surface: "detail-summary" }),
    ]);
    expect(groups.find((g) => g.metric === "CLS")).toMatchObject({ p75: 0, overBudget: false });
    expect(groups.find((g) => g.metric.startsWith("fresh_data"))).toMatchObject({ family: "stablecoin-detail", p75: 12000, overBudget: true });
    expect(routeFamily("/docs/api/")).toBe("prose");
    expect(summarizeVitals([])).toEqual([]);
  });
  it("rejects absent identities and unavailable numeric observations, never turning them into zero", () => {
    expect(() => summarizeVitals([row("(not set)", "a")])).toThrow("Missing GA4 event dimensions");
    expect(() => summarizeVitals([row("12", "(not set)")])).toThrow("Missing GA4 event dimensions");
    expect(() => summarizeVitals([row("NaN", "a")])).toThrow("Invalid numeric value");
  });
  it("paginates the Data API instead of truncating percentile input", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ rowCount: 2, rows: [row("100", "a")] }))
      .mockResolvedValueOnce(Response.json({ rowCount: 2, rows: [row("200", "b")] }));
    expect(await readGa4Rows("123", "not-a-real-token", 7, fetcher)).toHaveLength(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).offset).toBe(1);
    expect(fetcher.mock.calls[0][0]).toBe("https://analyticsdata.googleapis.com/v1beta/properties/123:runReport");
  });
  it("rejects lossy/thresholded reports and failed API reads", async () => {
    for (const metadata of [{ dataLossFromOtherRow: true }, { subjectToThresholding: true }, { samplingMetadatas: [{}] }]) {
      await expect(readGa4Rows("123", "token", 7, vi.fn().mockResolvedValue(Response.json({ metadata })))).rejects.toThrow("p75 cannot be computed reliably");
    }
    await expect(readGa4Rows("123", "token", 7, vi.fn().mockResolvedValue(new Response("", { status: 403 })))).rejects.toThrow("GA4 Data API HTTP 403");
    await expect(readGa4Rows("123", "token", 7, vi.fn().mockResolvedValue(Response.json({ rowCount: 1, rows: [] })))).rejects.toThrow("pagination ended");
  });
});
