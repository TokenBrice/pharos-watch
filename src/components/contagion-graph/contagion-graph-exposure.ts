import { HEIGHT, WIDTH, type GraphNode } from "@/lib/contagion-layout";

export interface ExposureOverlay {
  roots: readonly string[];
  rows: ReadonlyMap<string, { minHop: number; band: "material" | "minor" | "trace" | "unknown"; share: number | null; exposureUsd: number | null }>;
  highlightedPaths: readonly (readonly string[])[];
}

export function highlightedExposureEdges(paths: ExposureOverlay["highlightedPaths"]): Set<string> {
  const edges = new Set<string>();
  for (const path of paths) {
    for (let i = 1; i < path.length; i++) {
      // Paths run downstream from roots; graph links run dependent to upstream.
      edges.add(`${path[i]}\0${path[i - 1]}`);
    }
  }
  return edges;
}

export function footprintViewBox(nodes: readonly GraphNode[], positions: ReadonlyMap<string, { x: number; y: number }>, ids: ReadonlySet<string>, { nodeScale = 1, bottomInsetFraction = 0 }: { nodeScale?: number; bottomInsetFraction?: number } = {}): string {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const node of nodes) {
    const p = positions.get(node.id);
    if (!p || !ids.has(node.id)) continue;
    const pad = (node.r + 35) * nodeScale;
    left = Math.min(left, p.x - pad); top = Math.min(top, p.y - pad);
    right = Math.max(right, p.x + pad); bottom = Math.max(bottom, p.y + pad);
  }
  if (!Number.isFinite(left)) return `0 0 ${WIDTH} ${HEIGHT}`;
  // Grow, rather than merely shift, when a large footprint needs the space
  // reserved for the legend. The top bound therefore remains fully visible.
  const usableFraction = 1 - Math.max(0, Math.min(0.8, bottomInsetFraction));
  const scale = Math.max(1, (right - left) / WIDTH, (bottom - top) / (HEIGHT * usableFraction));
  const width = WIDTH * scale;
  const height = HEIGHT * scale;
  return `${(left + right - width) / 2} ${(top + bottom - height * usableFraction) / 2} ${width} ${height}`;
}

export function upstreamArrowPoint(source: { x: number; y: number }, upstream: { x: number; y: number }, radius: number) {
  const length = Math.hypot(upstream.x - source.x, upstream.y - source.y);
  const inset = length ? Math.min(radius + 5, length / 2) / length : 0;
  return { x: upstream.x + (source.x - upstream.x) * inset, y: upstream.y + (source.y - upstream.y) * inset };
}
