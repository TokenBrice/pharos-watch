import type { OgRouteCardKey } from "./og-route-cards";

/** One element of a 24×24 stroked icon (lucide icon-node shape, without React keys). */
export type OgRouteGlyphElement = readonly [
  tag: "path" | "rect" | "circle",
  attrs: Readonly<Record<string, string>>,
];

/**
 * Route glyphs for share cards: the geometry of each route's navigation icon in
 * `src/lib/nav-config.ts` (lucide icons, plus the custom FreezeWatch shield),
 * copied as data because the Worker and the static generator cannot import the
 * React icon components.
 */
export const OG_ROUTE_GLYPHS: Readonly<Record<OgRouteCardKey, readonly OgRouteGlyphElement[]>> = {
  home: [["rect", { width: "7", height: "9", x: "3", y: "3", rx: "1" }], ["rect", { width: "7", height: "5", x: "14", y: "3", rx: "1" }], ["rect", { width: "7", height: "9", x: "14", y: "12", rx: "1" }], ["rect", { width: "7", height: "5", x: "3", y: "16", rx: "1" }]],
  chains: [["path", { d: "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" }], ["path", { d: "M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" }], ["path", { d: "M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" }]],
  "dependency-map": [["rect", { x: "16", y: "16", width: "6", height: "6", rx: "1" }], ["rect", { x: "2", y: "16", width: "6", height: "6", rx: "1" }], ["rect", { x: "9", y: "2", width: "6", height: "6", rx: "1" }], ["path", { d: "M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" }], ["path", { d: "M12 12V8" }]],
  timeline: [["path", { d: "M15 12h-5" }], ["path", { d: "M15 8h-5" }], ["path", { d: "M19 17V5a2 2 0 0 0-2-2H4" }], ["path", { d: "M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" }]],
  flows: [["path", { d: "m21 16-4 4-4-4" }], ["path", { d: "M17 20V4" }], ["path", { d: "m3 8 4-4 4 4" }], ["path", { d: "M7 4v16" }]],
  freezewatch: [["path", { d: "M12 2 L20 7 L20 17 L12 22 L4 17 L4 7 Z" }], ["path", { d: "M12 8 L12 16" }], ["path", { d: "M8.5 10 L15.5 14" }], ["path", { d: "M8.5 14 L15.5 10" }]],
  liquidity: [["path", { d: "M2 12q2.5 2 5 0t5 0 5 0 5 0" }], ["path", { d: "M2 19q2.5 2 5 0t5 0 5 0 5 0" }], ["path", { d: "M2 5q2.5 2 5 0t5 0 5 0 5 0" }]],
  yield: [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" }], ["path", { d: "M12 18V6" }]],
  "alt-pegs": [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" }], ["path", { d: "M2 12h20" }]],
  coverage: [["path", { d: "M15 3v18" }], ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }], ["path", { d: "M21 9H3" }], ["path", { d: "M21 15H3" }]],
  stablecoins: [["path", { d: "M13.744 17.736a6 6 0 1 1-7.48-7.48" }], ["path", { d: "M15 6h1v4" }], ["path", { d: "m6.134 14.768.866-.5 2 3.464" }], ["circle", { cx: "16", cy: "8", r: "6" }]],
  upcoming: [["path", { d: "M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" }], ["path", { d: "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09" }], ["path", { d: "M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z" }], ["path", { d: "M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05" }]],
  compare: [["path", { d: "M8 3 4 7l4 4" }], ["path", { d: "M4 7h16" }], ["path", { d: "m16 21 4-4-4-4" }], ["path", { d: "M20 17H4" }]],
  screener: [["path", { d: "M10 5H3" }], ["path", { d: "M12 19H3" }], ["path", { d: "M14 3v4" }], ["path", { d: "M16 17v4" }], ["path", { d: "M21 12h-9" }], ["path", { d: "M21 19h-5" }], ["path", { d: "M21 5h-7" }], ["path", { d: "M8 10v4" }], ["path", { d: "M8 12H3" }]],
  funding: [["path", { d: "M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5" }]],
  pharoswatchbot: [["path", { d: "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" }], ["path", { d: "m21.854 2.147-10.94 10.939" }]],
  changelog: [["path", { d: "M13 21h8" }], ["path", { d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" }]],
  portfolio: [["path", { d: "M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" }], ["path", { d: "M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" }]],
};
