// Graph-local visual tokens. Scoped to the dependency-map SVG workspace only.
// Do not surface in semantic.css or the global token system.
//
// Light-mode fills do not use alpha because alpha-blended category swatches
// disappear on near-white canvas. We use OKLCH constants for any future
// graph-only color stops; current nodes color by grade (logo or ring), so
// category-fill WCAG is moot for our data model.

export const GRAPH_GRID_SIZE_PX = 24;

export const GRAPH_EDGE_HOVER_OPACITY = 0.9;
export const GRAPH_EDGE_HOVER_STROKE_WIDTH = 1.2;

export const GRAPH_DIM_NODE_OPACITY = 0.25;
export const GRAPH_DIM_EDGE_OPACITY = 0.1;

export const GRAPH_RIPPLE_HOP_DELAY_MS = 60;
export const GRAPH_RIPPLE_HOP_4_OPACITY = 0.55;
export const GRAPH_RIPPLE_HOP_4_EDGE_OPACITY = 0.45;
