import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { handleOg } from "../og";
import { handleScorecardOg } from "../og-scorecard";

vi.mock("../og-scorecard", () => ({
  handleScorecardOg: vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } })),
}));

beforeEach(() => { vi.mocked(handleScorecardOg).mockClear(); });

const image = (hash: string) => `https://pharos.watch/og/v2/image-${hash}.png`;
const HOME = image("5e2cce2c03a2b73b30d7389d55ebdee8d285e9f7819767f5778f42c51cff7e25");

describe("retired OG families", () => {
  it.each([
    ["stablecoin/usdt-tether", image("357efc65c1d23873b286cce31bb9cbee17967a5099fd0d5915c3a713a880b165")],
    ["stablecoin/usr-resolv", image("121c921b7064c95a17c9b87822eeb900c905175995eb821759c39660275aa5dc")],
    ["chain/ethereum", image("0056ee2be29f7f06e2bbf3d4084f301f192d22b14c7a1b04bd7472e49e4534e7")],
    ["chain/tron", image("a6615e69ddd4da6d368c6ebea9066e62f1c919018e0453ae5ef4db50a04aefb1")],
    ["page/chains", image("f54acea33281b9300b95a931aaa90ac39cb8b3dc0a8e4d293ee8e39ee092726a")],
    ["page/upcoming", image("e442f3831e244fdf700b1dec71c8c70a997ad9ce3de30bebebf36722f82eb528")],
    ["depeg", image("b8af49beb1fb4eb0bda4038228b7260b1d00f1fb0201749f6d2b14c3f7f4174f")],
    ["safety-scores", image("cf7d3bd92d862fcba78cbdfb297ad16389ccf5f31aa7b9cebbe55863e7715b3c")],
    ["stability-index", image("86ca3d4fd645b33d07d6262c59c6e8cf9a37b5d6ecc0ab361d4b9ca609a83a50")],
    ["page/home", HOME],
    ["stablecoin/not-a-coin", HOME],
    ["stablecoin/usdt%2dtether", HOME],
    ["chain/%E0%A4%A", HOME],
    ["page/not-a-route", HOME],
  ])("301s /api/og/%s and its v2 alias without reading or rendering", async (suffix, location) => {
    const db = mockD1([]);
    for (const path of [`/api/og/${suffix}`, `/api/og/v2/${suffix}`]) {
      const response = await handleOg(db, path);
      expect(response?.status).toBe(301);
      expect(response?.headers.get("Location")).toBe(location);
      expect(response?.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    }
    expect(db.getHistory()).toHaveLength(0);
    expect(handleScorecardOg).not.toHaveBeenCalled();
  });

  it("leaves unrecognized OG paths to the router's 404", async () => {
    for (const path of ["/api/og/unknown", "/api/og/stablecoin/", "/api/og/v2/scorecard/a/b"]) {
      expect(await handleOg(mockD1([]), path)).toBeNull();
    }
  });
});

describe("dated scorecard route", () => {
  it.each(["usdt-tether", "safety-scores"])("dispatches the versioned scorecard subject %s", async (id) => {
    const db = mockD1([]);
    const response = await handleOg(db, API_PATHS.ogScorecard(id));
    expect(handleScorecardOg).toHaveBeenLastCalledWith(db, id);
    expect(response?.headers.get("Content-Type")).toBe("image/png");
  });

  it.each([["%E0%A4%A", 400], ["usdt%2dtether", 404]])("rejects capture %s before rendering", async (capture, status) => {
    expect((await handleOg(mockD1([]), `/api/og/v2/scorecard/${capture}`))?.status).toBe(status);
    expect(handleScorecardOg).not.toHaveBeenCalled();
  });
});
