export const MAX_MAIN_CANVAS_PIXELS = 8_000_000;
export const MAX_TERRAIN_CACHE_PIXELS = 6_000_000;
export const MAX_WEATHER_CACHE_PIXELS = 2_000_000;
export const MAX_MINIMAP_PIXELS = 300_000;
export const MAX_TOTAL_BACKING_PIXELS = 14_000_000;

export function resolveCanvasBudget(input: {
  cssHeight: number;
  cssWidth: number;
  requestedDpr: number;
}) {
  const cssPixels = Math.max(1, Math.floor(input.cssWidth) * Math.floor(input.cssHeight));
  const requestedDpr = Number.isFinite(input.requestedDpr) ? Math.max(1, input.requestedDpr) : 1;
  const maxDprForMainCanvas = Math.sqrt(MAX_MAIN_CANVAS_PIXELS / cssPixels);
  const effectiveDpr = Math.max(1, Math.min(2, requestedDpr, maxDprForMainCanvas));
  const backingWidth = Math.max(1, Math.floor(input.cssWidth * effectiveDpr));
  const backingHeight = Math.max(1, Math.floor(input.cssHeight * effectiveDpr));

  return {
    backingHeight,
    backingPixels: backingWidth * backingHeight,
    backingWidth,
    effectiveDpr,
    maxMainCanvasPixels: MAX_MAIN_CANVAS_PIXELS,
    maxTotalBackingPixels: MAX_TOTAL_BACKING_PIXELS,
    requestedDpr,
  };
}
