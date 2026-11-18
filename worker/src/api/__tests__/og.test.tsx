import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { createEdgeCacheContext } from "../../handlers/http/edge-cache";
import { handleOg } from "../og";
import legacyHashes from "../og-legacy-redirects.json";
import { handleScorecardOg } from "../og-scorecard";

vi.mock("../og-scorecard", () => ({
  handleScorecardOg: vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } })),
}));

beforeEach(() => { vi.mocked(handleScorecardOg).mockClear(); });

const image = (hash: string) => `https://pharos.watch/og/v2/image-${hash}.png`;
const HOME = image("5e2cce2c03a2b73b30d7389d55ebdee8d285e9f7819767f5778f42c51cff7e25");

describe("retired OG families", () => {
  const destinations = legacyHashes as Record<string, string>;
  it.each([
    "stablecoin/usdt-tether", "stablecoin/usr-resolv", "chain/ethereum", "chain/tron",
    "page/chains", "page/upcoming", "depeg", "safety-scores", "stability-index", "page/home",
    "stablecoin/not-a-coin", "stablecoin/usdt%2dtether", "chain/%E0%A4%A", "page/not-a-route",
  ])("301s /api/og/%s and its v2 alias", async (suffix) => {
    const location = destinations[suffix] ? image(destinations[suffix]) : HOME;
    const db = mockD1([]);
    for (const path of [`/api/og/${suffix}`, `/api/og/v2/${suffix}`]) {
      const response = await handleOg(db, path);
      expect(response?.status).toBe(301);
      expect(response?.headers.get("Location")).toBe(location);
      expect(response?.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    }
    expect(db.getHistory()).toHaveLength(0);
    expect(image(destinations["page/home"])).toBe(HOME);
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
    for (const family of ["scorecard", "dossier"]) {
      expect((await handleOg(mockD1([]), `/api/og/v2/${family}/${capture}`))?.status).toBe(status);
    }
    expect(handleScorecardOg).not.toHaveBeenCalled();
  });
});

it("serves the scorecard unchanged with a coin-specific cache key", async () => {
  const db = mockD1([]);
  const png = new Response("PNG", { headers: { "X-Pharos-Scorecard": "metadata" } });
  vi.mocked(handleScorecardOg).mockResolvedValueOnce(png);
  const path = "/api/og/v2/dossier/usdc-circle";
  expect(await handleOg(db, path, "a".repeat(64))).toBe(png);
  expect(handleScorecardOg).toHaveBeenCalledExactlyOnceWith(db, "usdc-circle");
  const url = new URL(`https://api.pharos.watch${path}?fallback=${"a".repeat(64)}`);
  expect(createEdgeCacheContext(new Request(url), url).cacheKey.url).toBe(`https://api.pharos.watch${path}`);
});

it("uses a short-lived evergreen redirect for unavailable or unknown dossiers", async () => {
  const db = mockD1([]);
  const hash = "a".repeat(64);
  for (const [id, status, fallback, location] of [
    ["usdc-circle", 404, hash, image(hash)], ["usdc-circle", 503, hash, image(hash)],
    ["not-a-coin", 0, hash, image(hash)], ["safety-scores", 0, "A".repeat(64), HOME],
    ["not-a-coin", 0, hash + "\n", HOME], ["not-a-coin", 0, null, HOME],
  ] as const) {
    if (status) vi.mocked(handleScorecardOg).mockResolvedValueOnce(new Response(null, { status }));
    const response = await handleOg(db, `/api/og/v2/dossier/${id}`, fallback);
    expect([response?.status, response?.headers.get("Location"), response?.headers.get("Cache-Control")]).toEqual([302, location, "public, max-age=180"]);
  }
  expect(handleScorecardOg).toHaveBeenCalledTimes(2);
});
