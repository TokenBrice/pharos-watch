import { describe, expect, it } from "vitest";
import { diffSitemaps, planPing } from "../ci/indexnow-ping.mjs";

const sm = (rows: Record<string, string>) =>
  `<urlset>${Object.entries(rows).map(([u, d]) => `<url><loc>${u}</loc><lastmod>${d}</lastmod></url>`).join("")}</urlset>`;

describe("indexnow-ping", () => {
  const prev = sm({ a: "1", b: "1", c: "1" });
  it("returns new, removed and lastmod-changed URLs only", () => {
    expect(diffSitemaps(prev, sm({ a: "1", b: "2", d: "1" })).sort()).toEqual(["b", "c", "d"]);
  });
  it("sends nothing without a previous sitemap, without changes, or over the cap", () => {
    expect(planPing("", prev).skip).toMatch(/no previous/);
    expect(planPing(prev, prev).skip).toMatch(/no sitemap changes/);
    expect(planPing(prev, sm({ x: "1", y: "1" }), 2).skip).toMatch(/exceed/);
    expect(planPing(prev, sm({ a: "1", b: "2", c: "1" })).urls).toEqual(["b"]);
  });
});
