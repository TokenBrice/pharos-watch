import { describe, expect, it } from "vitest";
import { arrangeClusterCoins, resolvePackedCoinOverlaps, type PackingInput, type PackedCoin } from "@/lib/alt-peg-packing";

function input(sizes: number[]): PackingInput[] {
  return sizes.map((sizePx, i) => ({ id: `c${i}`, sizePx, marketCap: sizePx * 1_000_000 }));
}

describe("arrangeClusterCoins", () => {
  const anchor = { x: 50, y: 30 };

  it("places a single coin at the anchor", () => {
    const placed = arrangeClusterCoins(anchor, input([60]));
    expect(placed).toHaveLength(1);
    expect(placed[0].x).toBe(50);
    expect(placed[0].y).toBe(30);
  });

  it("places the largest coin at the anchor when multiple are given", () => {
    const placed = arrangeClusterCoins(anchor, input([40, 100, 60]));
    const atAnchor = placed.find((p) => p.x === 50 && p.y === 30);
    expect(atAnchor).toBeDefined();
    expect(atAnchor!.sizePx).toBe(100);
  });

  it("produces no center-to-center overlaps within a cluster", () => {
    const sizes = [100, 80, 60, 50, 45, 40, 35, 32, 30, 28, 28, 26, 26];
    const placed = arrangeClusterCoins(anchor, input(sizes));
    const FRAME_W = 900;
    const FRAME_H = 460;
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const dx = (placed[i].x - placed[j].x) * (FRAME_W / 100);
        const dy = (placed[i].y - placed[j].y) * (FRAME_H / 100);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = ((placed[i].sizePx + placed[j].sizePx) / 2) * 0.9;
        expect(dist).toBeGreaterThanOrEqual(minDist);
      }
    }
  });

  it("returns coins sorted largest-first", () => {
    const placed = arrangeClusterCoins(anchor, input([30, 100, 50, 80]));
    const sizes = placed.map((p) => p.sizePx);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it("returns empty array for empty input", () => {
    expect(arrangeClusterCoins(anchor, [])).toEqual([]);
  });

  it("separates already packed coins from neighboring peg anchors", () => {
    const coins: PackedCoin[] = [
      { id: "eur-leader", sizePx: 48, marketCap: 400_000_000, x: 52, y: 20 },
      { id: "chf-leader", sizePx: 42, marketCap: 180_000_000, x: 51, y: 22 },
      { id: "gbp-leader", sizePx: 36, marketCap: 90_000_000, x: 50, y: 18 },
    ];

    const placed = resolvePackedCoinOverlaps(coins, { paddingPx: 6 });

    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const dx = (placed[i].x - placed[j].x) * 9;
        const dy = (placed[i].y - placed[j].y) * 4.6;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = (placed[i].sizePx + placed[j].sizePx) / 2 + 6;
        expect(dist).toBeGreaterThanOrEqual(minDist - 0.5);
      }
    }
  });
});
