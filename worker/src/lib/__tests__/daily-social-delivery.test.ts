import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { buildDailySocialTweetText, buildDailySocialAltText, type DailySocialSnapshot } from "@shared/lib/daily-social";
import { getDailySocialEdition } from "@shared/lib/daily-social-schedule";
import { deliverDailySocial } from "../daily-social-delivery";
import { postImageTweet } from "../twitter";

vi.mock("../twitter", async (importOriginal) => ({ ...(await importOriginal<typeof import("../twitter")>()), postImageTweet: vi.fn() }));
const fixtures = createLatestSchemaFixtureTracker();
const now = Date.parse("2026-09-14T12:00:00Z") / 1000;
const creds = { apiKey: "a", apiSecret: "b", accessToken: "c", accessTokenSecret: "d" };
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
async function mockArtifacts(snapshotOverrides: Partial<DailySocialSnapshot> = {}, manifestOverrides: Record<string, unknown> = {}, at = now) {
  const snapshot: DailySocialSnapshot = {
    schemaVersion: 1, ...getDailySocialEdition(at), capturedAt: at - 600, asOf: at - 900,
    title: "Top stablecoin growth", subtitle: "Seven-day change", unit: "usd",
    rows: [{ id: "usdc-circle", name: "USD Coin", symbol: "USDC", value: 20000000, context: "+2% over seven days" }],
    highlights: [], source: "Pharos", methodology: "Seven-day absolute circulating market-cap growth.", ...snapshotOverrides,
  };
  const digest = await crypto.subtle.digest("SHA-256", png);
  const manifest = { snapshot, schemaVersion: 1,
    imageSha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""),
    tweetText: buildDailySocialTweetText(snapshot), altText: buildDailySocialAltText(snapshot), ...manifestOverrides };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith(".json")
    ? new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } })
    : new Response(png, { headers: { "Content-Type": "image/png" } })));
}
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(now * 1000); });
afterEach(() => { vi.restoreAllMocks(); fixtures.closeAll(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("daily social delivery", () => {
  it.each(["2026-09-14T12:00:00Z", "2026-12-14T13:00:00Z", "2026-03-29T12:00:00Z", "2026-10-25T13:00:00Z"])("publishes at 14:00 Belgrade with DST: %s", async (iso) => {
    const at = Date.parse(iso) / 1000;
    vi.mocked(Date.now).mockReturnValue(at * 1000);
    await mockArtifacts({}, {}, at);
    vi.mocked(postImageTweet).mockResolvedValue({ tweetId: "123", mediaAttached: true });
    const { db } = fixtures.open();
    expect(await deliverDailySocial(db, creds, at)).toEqual({ status: "sent", tweetId: "123" });
    expect(await deliverDailySocial(db, creds, at + 300)).toEqual({ status: "skipped", reason: "already-sent" });
    expect(postImageTweet).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, `https://pharos.watch/social-posts/${iso.slice(0, 10)}.json`, expect.anything());
  });
  it("accepts a labeled fresh overview fallback for the scheduled topic", async () => {
    await mockArtifacts({ topic: "market-overview", fallbackFor: "market-growth" });
    vi.mocked(postImageTweet).mockResolvedValue({ tweetId: "123", mediaAttached: true });
    expect(await deliverDailySocial(fixtures.open().db, creds, now)).toEqual({ status: "sent", tweetId: "123" });
  });
  it("holds ambiguous tweet outcomes permanently instead of replaying", async () => {
    await mockArtifacts();
    vi.mocked(postImageTweet).mockRejectedValue(new Error("request outcome unknown"));
    const { db } = fixtures.open();
    await expect(deliverDailySocial(db, creds, now)).rejects.toThrow("request outcome unknown");
    expect(await deliverDailySocial(db, creds, now + 300)).toEqual({ status: "skipped", reason: "execution-unknown" });
    expect(postImageTweet).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    { asOf: now - 10801 }, { capturedAt: now - 7201, asOf: now - 8000 },
    { asOf: now + 600 }, { capturedAt: now }, { scheduledAt: now + 60 },
    { editionDate: "2026-09-13" }, { topic: "yield-watch" as const },
  ])("rejects stale, future or wrong edition artifacts: %j", async (override) => {
    await mockArtifacts(override);
    await expect(deliverDailySocial(fixtures.open().db, creds, now)).rejects.toThrow();
    expect(postImageTweet).not.toHaveBeenCalled();
  });
  it.each([{ imageSha256: "0".repeat(64) }, { tweetText: "manipulated" }, { altText: "manipulated" }])("rejects manipulated copy and checksums: %j", async (override) => {
    await mockArtifacts({}, override);
    await expect(deliverDailySocial(fixtures.open().db, creds, now)).rejects.toThrow();
    expect(postImageTweet).not.toHaveBeenCalled();
  });
  it.each([-1, 3600])("never fetches before opening or after cutoff: %i seconds", async (offset) => {
    await mockArtifacts();
    vi.mocked(Date.now).mockReturnValue((now + offset) * 1000);
    expect(await deliverDailySocial(fixtures.open().db, creds, now + offset)).toEqual({ status: "skipped", reason: "outside-publication-window" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a stale scheduled invocation against real wall-clock time", async () => {
    await mockArtifacts();
    vi.mocked(Date.now).mockReturnValue((now + 86400) * 1000);
    expect(await deliverDailySocial(fixtures.open().db, creds, now)).toEqual({ status: "skipped", reason: "outside-publication-window" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rechecks the publication cutoff after downloading artifacts", async () => {
    await mockArtifacts();
    const realFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (...args) => {
      const response = await realFetch(...args);
      if (String(args[0]).endsWith(".png")) vi.mocked(Date.now).mockReturnValue((now + 3600) * 1000);
      return response;
    });
    await expect(deliverDailySocial(fixtures.open().db, creds, now)).rejects.toThrow("publication window elapsed");
    expect(postImageTweet).not.toHaveBeenCalled();
  });
});
