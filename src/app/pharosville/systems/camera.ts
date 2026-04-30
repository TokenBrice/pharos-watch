import type { IsoCamera, MapLike, ScreenPoint } from "./projection";
import { fitCameraToMap, mapIsoBounds, tileToIso, zoomCameraAt } from "./projection";

export interface CameraBoundsInput {
  map: MapLike;
  viewport: ScreenPoint;
  padding?: {
    bottom?: number;
    left?: number;
    right?: number;
    top?: number;
  };
}

function cameraPadding(input?: CameraBoundsInput["padding"]) {
  return {
    bottom: input?.bottom ?? 80,
    left: input?.left ?? 0,
    right: input?.right ?? 128,
    top: input?.top ?? 0,
  };
}

export function defaultCamera(input: {
  height: number;
  map: MapLike;
  width: number;
}): IsoCamera {
  const fitted = fitCameraToMap({
    ...input,
    padding: cameraPadding(),
  });
  const tightened = zoomCameraAt(
    fitted,
    { x: input.width * 0.54, y: input.height * 0.5 },
    fitted.zoom * 1.13,
  );
  return clampCameraToMap(tightened, {
    map: input.map,
    viewport: { x: input.width, y: input.height },
  });
}

export function clampCameraToMap(camera: IsoCamera, input: CameraBoundsInput): IsoCamera {
  const padding = cameraPadding(input.padding);
  const bounds = mapIsoBounds(input.map);
  const left = padding.left;
  const right = Math.max(left + 1, input.viewport.x - padding.right);
  const top = padding.top;
  const bottom = Math.max(top + 1, input.viewport.y - padding.bottom);
  const contentWidth = (bounds.maxX - bounds.minX) * camera.zoom;
  const contentHeight = (bounds.maxY - bounds.minY) * camera.zoom;
  const availableWidth = right - left;
  const availableHeight = bottom - top;

  const offsetX = clampOffset({
    availableSize: availableWidth,
    contentSize: contentWidth,
    maxCoordinate: bounds.maxX,
    minCoordinate: bounds.minX,
    offset: camera.offsetX,
    rangeEnd: right,
    rangeStart: left,
    zoom: camera.zoom,
  });
  const offsetY = clampOffset({
    availableSize: availableHeight,
    contentSize: contentHeight,
    maxCoordinate: bounds.maxY,
    minCoordinate: bounds.minY,
    offset: camera.offsetY,
    rangeEnd: bottom,
    rangeStart: top,
    zoom: camera.zoom,
  });

  return {
    ...camera,
    offsetX: Math.round(offsetX),
    offsetY: Math.round(offsetY),
  };
}

export function panCamera(camera: IsoCamera, delta: ScreenPoint, bounds?: CameraBoundsInput): IsoCamera {
  const next = {
    ...camera,
    offsetX: camera.offsetX + delta.x,
    offsetY: camera.offsetY + delta.y,
  };
  return bounds ? clampCameraToMap(next, bounds) : next;
}

export function zoomIn(camera: IsoCamera, viewport: ScreenPoint, map?: MapLike): IsoCamera {
  const next = zoomCameraAt(camera, { x: viewport.x / 2, y: viewport.y / 2 }, camera.zoom * 1.18);
  return map ? clampCameraToMap(next, { map, viewport }) : next;
}

export function zoomOut(camera: IsoCamera, viewport: ScreenPoint, map?: MapLike): IsoCamera {
  const next = zoomCameraAt(camera, { x: viewport.x / 2, y: viewport.y / 2 }, camera.zoom / 1.18);
  return map ? clampCameraToMap(next, { map, viewport }) : next;
}

export function followTile(input: {
  camera: IsoCamera;
  map?: MapLike;
  tile: ScreenPoint;
  viewport: ScreenPoint;
}): IsoCamera {
  const iso = tileToIso(input.tile);
  const next = {
    ...input.camera,
    offsetX: input.viewport.x / 2 - iso.x * input.camera.zoom,
    offsetY: input.viewport.y / 2 - iso.y * input.camera.zoom,
  };
  return input.map ? clampCameraToMap(next, { map: input.map, viewport: input.viewport }) : next;
}

export function cameraZoomLabel(camera: IsoCamera): string {
  return `${Math.round(camera.zoom * 100)}%`;
}

function clampOffset(input: {
  availableSize: number;
  contentSize: number;
  maxCoordinate: number;
  minCoordinate: number;
  offset: number;
  rangeEnd: number;
  rangeStart: number;
  zoom: number;
}) {
  if (input.contentSize <= input.availableSize) {
    return input.rangeStart + (input.availableSize - input.contentSize) / 2 - input.minCoordinate * input.zoom;
  }
  const minOffset = input.rangeEnd - input.maxCoordinate * input.zoom;
  const maxOffset = input.rangeStart - input.minCoordinate * input.zoom;
  return Math.max(minOffset, Math.min(maxOffset, input.offset));
}
