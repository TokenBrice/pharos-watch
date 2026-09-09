import { describe, expect, it, vi } from "vitest";
import type { KVNamespace } from "@shared/types/cloudflare-runtime";
import { buildDailySocialTweetText, buildDailySocialAltText, type DailySocialSnapshot } from "@shared/lib/daily-social";
import { getDailySocialEdition } from "@shared/lib/daily-social-schedule";
import { onRequest } from "../social-posts/[[path]]";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
async function context(path: string, bytes = png, overrides: Record<string, unknown> = {}) {
  const at = Date.parse("2026-09-14T12:00:00Z") / 1000;
  const date = /^\d{4}-\d{2}-\d{2}/.exec(path)?.[0] ?? "2026-09-14";
  const snapshot: DailySocialSnapshot = {
    schemaVersion: 1, ...getDailySocialEdition(Date.parse(`${date}T12:00:00Z`) / 1000 || at), editionDate: date,
    scheduledAt: Date.parse(`${date}T12:00:00Z`) / 1000 || at,
    capturedAt: (Date.parse(`${date}T12:00:00Z`) / 1000 || at) - 600, asOf: (Date.parse(`${date}T12:00:00Z`) / 1000 || at) - 900,
    title: "Growth", subtitle: "Seven-day change", unit: "usd",
    rows: [{ id: "usdc-circle", name: "USD Coin", symbol: "USDC", value: 1000000, context: "+1%" }],
    highlights: [], source: "Pharos", methodology: "Seven-day dollar growth.",
  };
  const imageSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", png)), (b) => b.toString(16).padStart(2, "0")).join("");
  const manifest = { schemaVersion: 1, snapshot, imageSha256, tweetText: buildDailySocialTweetText(snapshot), altText: buildDailySocialAltText(snapshot), ...overrides };
  const get = vi.fn(async (key: string) => new Response(key.endsWith(".json") ? JSON.stringify(manifest) : new Uint8Array(bytes)).body);
  return { request: new Request(`https://pharos.watch/social-posts/${path}`), env: { SELECTOR_SNAPSHOTS: { get } as unknown as KVNamespace }, get, imageSha256 };
}
describe("daily social artifacts", () => {
  it.each(["2026-09-14", "2026-09-15", "2026-09-20"])("serves immutable committed graphics for any day: %s", async (date) => {
    const ctx = await context(`${date}.png`);
    const response = await onRequest(ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(ctx.get).toHaveBeenNthCalledWith(1, `daily-social:${date}.json`, "stream");
    expect(ctx.get).toHaveBeenNthCalledWith(2, `daily-social:${date}:${ctx.imageSha256}.png`, "stream");
  });
  it.each(["2026-02-30.png", "latest.png", "2026-09-14.svg"])("rejects invalid edition paths: %s", async (path) => {
    const ctx = await context(path);
    expect((await onRequest(ctx)).status).toBe(404);
    expect(ctx.get).not.toHaveBeenCalled();
  });
  it("never serves an uncommitted orphan PNG", async () => {
    const ctx = await context("2026-09-14.png");
    ctx.get.mockResolvedValueOnce(null);
    expect((await onRequest(ctx)).status).toBe(404);
    expect(ctx.get).toHaveBeenCalledTimes(1);
  });
  it("serves manifests without fetching the image", async () => {
    const ctx = await context("2026-09-14.json");
    expect((await onRequest(ctx)).status).toBe(200);
    expect(ctx.get).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized streams, non-PNG content and checksum mismatches", async () => {
    for (const bytes of [new Uint8Array(5 * 1024 * 1024 + 1), new TextEncoder().encode("<html>error</html>"), new Uint8Array([...png, 1])]) {
      const response = await onRequest(await context("2026-09-14.png", bytes));
      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
  it("rejects corrupted manifest copy", async () => {
    expect((await onRequest(await context("2026-09-14.json", png, { tweetText: "manipulated" }))).status).toBe(502);
  });
});
