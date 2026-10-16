/**
 * Scene kit placement: hover tags and docked inspector cards over a scene frame. Runtime inputs are measured sizes;
 * everything else is pure.
 */
import type { SceneBox, ScenePoint } from "./projection";

/** Rectangle in CSS px relative to the scene frame (or the viewport, where stated). */
export interface SceneRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Whether two rects come within `m` px of each other. */
const rectsHit = (a: SceneRect, b: SceneRect, m: number) => a.left < b.right + m && a.right > b.left - m && a.top < b.bottom + m && a.bottom > b.top - m;

/** An SVG-unit box as frame px, for a frame showing `viewBox` at `scale` px per unit. */
export function boxToFrameRect(box: SceneBox, viewBox: readonly number[], scale: number): SceneRect {
  return { left: (box.x0 - viewBox[0]) * scale, top: (box.y0 - viewBox[1]) * scale, right: (box.x1 - viewBox[0]) * scale, bottom: (box.y1 - viewBox[1]) * scale };
}

/**
 * Hover tag: tries above, above-right, above-left, right, left, below the target and takes the first position clear
 * of every obstacle (padded 3 px) inside the frame and below `top` (the sticky chrome's edge in frame px, when the
 * frame is scrolled under it), else the one with the fewest hits. `collisions` is −1 when no candidate fits.
 */
export function placeTag(input: {
  stone: SceneRect;
  tag: { width: number; height: number };
  frame: { width: number; height: number };
  obstacles: readonly SceneRect[];
  top?: number;
}): {
  x: number;
  y: number;
  collisions: number;
} {
  const { stone, tag, frame, top = 0 } = input;
  const tw = tag.width;
  const th = tag.height;
  const cx = (stone.left + stone.right) / 2;
  const midY = (stone.top + stone.bottom) / 2;
  const cands: ScenePoint[] = [
    [cx - tw / 2, stone.top - th - 6],
    [stone.right + 4, stone.top - th + 4],
    [stone.left - tw - 4, stone.top - th + 4],
    [stone.right + 6, midY - th / 2],
    [stone.left - tw - 6, midY - th / 2],
    [cx - tw / 2, stone.bottom + 6],
  ];
  const obstacles = input.obstacles.map((o) => ({ x0: o.left - 3, y0: o.top - 3, x1: o.right + 3, y1: o.bottom + 3 }));
  let chosen = cands[0];
  let bestHits = Infinity;
  for (const [x, y] of cands) {
    if (x < 0 || y < Math.max(0, top) || x + tw > frame.width || y + th > frame.height) continue;
    const hits = obstacles.filter((o) => x < o.x1 && x + tw > o.x0 && y < o.y1 && y + th > o.y0).length;
    if (hits < bestHits) {
      bestHits = hits;
      chosen = [x, y];
      if (!hits) break;
    }
  }
  return { x: chosen[0], y: chosen[1], collisions: bestHits === Infinity ? -1 : bestHits };
}

/**
 * Inspector docking: beside the target on the side with room, inside the band of the frame that is visible below the
 * sticky chrome (`chromeTop`, viewport px), clear of a fixed bottom-right control (`corner`, e.g. a Feedback button:
 * a card reaching within `corner.width` px of the viewport's right edge stops `corner.height` px above its bottom),
 * joined to `medal` by a hairline connector. `avoid` lists volumes and text the card must not cover: on either side
 * the card takes the free run of the band nearest the target (the side with more room wins a tie), shortening (it
 * scrolls) down to 220 px; if no run is tall enough it keeps the plain placement. `soft` lists labels: side, run and
 * height stay as found, but within its run (and up to 48 px further from the target) the card slides to cover as few
 * labels as it can, nearest the target on a tie; a label never costs the card height. With the frame scrolled
 * (nearly) out of view the card stays by its target inside the frame instead of following the viewport. Viewport px.
 */
export function placeInspectorCard(input: {
  stone: SceneRect;
  frame: SceneRect;
  medal: ScenePoint;
  card: { width: number; height: number };
  viewport: { width: number; height: number };
  chromeTop: number;
  corner?: { width: number; height: number } | null;
  avoid?: readonly SceneRect[];
  soft?: readonly SceneRect[];
}): { x: number; y: number; maxHeight: number; connector: { x1: number; y1: number; x2: number; y2: number } } {
  const { stone, frame, medal, card, viewport, chromeTop, corner = null, avoid = [], soft = [] } = input;
  const w = card.width;
  const minH = Math.min(card.height, 220);
  const visibleTop = Math.max(chromeTop, frame.top);
  const visibleBottom = Math.min(viewport.height - 8, frame.bottom);
  // the scene is (nearly) out of view: dock by the target inside the frame, not in the viewport band
  const onScreen = visibleBottom - visibleTop >= minH;
  const topMin = onScreen ? visibleTop : frame.top;
  const cornerTop = corner ? viewport.height - corner.height : viewport.height - 8;
  const roomR = frame.right - stone.right;
  const roomL = stone.left - frame.left;
  const right = stone.right + 28;
  const left = Math.max(frame.left + 4, stone.left - 28 - w);
  const sides = roomR >= w + 36 && (roomR >= roomL || roomL < w + 36) ? [right, ...(roomL >= w + 36 ? [left] : [])] : [left, ...(roomR >= w + 36 ? [right] : [])];
  const mid = (stone.top + stone.bottom) / 2;
  const bottomOf = (x: number) => (onScreen ? Math.min(corner && x + w > viewport.width - corner.width ? cornerTop : viewport.height - 8, frame.bottom) : frame.bottom);

  // every free run of the band on each side; the one nearest the target wins (the preferred side on a tie)
  const gap = ([a, b]: [number, number]) => (mid < a ? a - mid : mid > b ? mid - b : 0);
  let spot: { x: number; top: number; bottom: number; gap: number } | null = null;
  for (const x of sides) {
    let runs: [number, number][] = [[topMin, bottomOf(x)]];
    for (const r of avoid) {
      if (r.left >= x + w + 8 || r.right <= x - 8) continue;
      runs = runs.flatMap(([a, b]): [number, number][] => {
        const cut0 = r.top - 8;
        const cut1 = r.bottom + 8;
        if (cut1 <= a || cut0 >= b) return [[a, b]];
        return [...(cut0 > a ? [[a, cut0] as [number, number]] : []), ...(cut1 < b ? [[cut1, b] as [number, number]] : [])];
      });
    }
    for (const run of runs) {
      if (run[1] - run[0] < minH || (spot && gap(run) >= spot.gap)) continue;
      spot = { x, top: run[0], bottom: run[1], gap: gap(run) };
    }
  }
  const { x: x0, top, bottom } = spot ?? { x: sides[0], top: topMin, bottom: bottomOf(sides[0]) };
  const h = Math.min(card.height, bottom - top);
  const centred = Math.min(Math.max(mid - h / 2, top), bottom - h);
  // labels: slide along the run (and away from the target) to the spot covering the fewest, nearest the target on a tie
  let x = x0;
  let y = centred;
  if (soft.length) {
    const away = x0 >= stone.right ? 1 : -1;
    let best = { covered: Infinity, cost: Infinity };
    for (let dx = 0; dx <= 48; dx += 12) {
      const cx = x0 + away * dx;
      if (dx && (cx < frame.left + 4 || cx + w > frame.right - 4)) break;
      const ys = [centred, top, bottom - h, ...soft.flatMap((r) => [r.bottom + 8, r.top - 8 - h])].map((v) => Math.min(Math.max(v, top), bottom - h));
      for (const cy of ys) {
        const rect = { left: cx, top: cy, right: cx + w, bottom: cy + h };
        // the run already keeps the unshifted column clear; a shifted one re-checks the hard obstacles and the band
        if (dx && (cy + h > bottomOf(cx) || avoid.some((r) => rectsHit(rect, r, 8)))) continue;
        const covered = soft.filter((r) => rectsHit(rect, r, 0)).length;
        const cost = Math.abs(cy - centred) + dx;
        if (covered < best.covered || (covered === best.covered && cost < best.cost)) {
          best = { covered, cost };
          x = cx;
          y = cy;
        }
      }
    }
  }
  const ex = x > medal[0] ? x : x + w;
  const ey = Math.min(Math.max(medal[1], y + 14), y + h - 14);
  return { x, y, maxHeight: h, connector: { x1: medal[0], y1: medal[1], x2: ex, y2: ey } };
}
