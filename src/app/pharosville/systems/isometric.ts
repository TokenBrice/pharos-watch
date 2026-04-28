export const TILE_W = 64;
export const TILE_H = 32;
export const SCENE_GRID = 40;

export interface TileCoord { tileX: number; tileY: number; }
export interface ScreenCoord { x: number; y: number; }
export interface DepthInput extends TileCoord { elevation: number; }

export function worldToScreen({ tileX, tileY }: TileCoord): ScreenCoord {
  return {
    x: ((tileX - tileY) * TILE_W) / 2,
    y: ((tileX + tileY) * TILE_H) / 2,
  };
}

export function screenToWorld({ x, y }: ScreenCoord): TileCoord {
  return {
    tileX: x / TILE_W + y / TILE_H,
    tileY: y / TILE_H - x / TILE_W,
  };
}

export function depthKey({ tileX, tileY, elevation }: DepthInput): number {
  return tileX + tileY + elevation * SCENE_GRID * 2;
}
