/**
 * Runtime-neutral composition validation for static maps.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Circle {
  cx: number;
  cy: number;
  r: number;
}

export interface SceneCircle extends Circle {
  id: string;
  role?: "bubble" | "obstacle";
}

export interface SceneRectangle extends Rect {
  id: string;
  role?: "obstacle" | "decoration";
}

export interface ReservedRegion extends Rect {
  id: string;
  allowedAnnotationIds?: readonly string[];
  allowedClassIds?: readonly string[];
}

export interface SceneOrbit {
  id: string;
  cx: number;
  cy: number;
  innerRx: number;
  innerRy: number;
  outerRx: number;
  outerRy: number;
  circleIds: readonly string[];
}

export interface PlacedAnnotation {
  id: string;
  classId: string;
  bounds: Rect;
}

export interface AnnotationScene {
  frame: Rect;
  circles?: readonly SceneCircle[];
  rectangles?: readonly SceneRectangle[];
  reservedRegions?: readonly ReservedRegion[];
  orbits?: readonly SceneOrbit[];
  annotations?: readonly PlacedAnnotation[];
}

export interface AnnotationPolicy {
  bubbleGap?: number;
  labelGap?: number;
  frameInset?: number;
}

export type ViolationCode =
  | "non-finite"
  | "invalid-geometry"
  | "duplicate-id"
  | "frame-bound"
  | "orbit-bound"
  | "bubble-bubble"
  | "circle-circle"
  | "circle-rectangle"
  | "rectangle-rectangle"
  | "reserved-circle"
  | "reserved-rectangle"
  | "label-label"
  | "label-bubble"
  | "label-circle"
  | "label-rectangle"
  | "label-reserved";

export interface SceneViolation {
  code: ViolationCode;
  ids: readonly string[];
  message: string;
}

function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finite(values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

function rectInFrame(rect: Rect, frame: Rect, inset: number): boolean {
  return rect.x >= frame.x + inset && rect.y >= frame.y + inset &&
    rect.x + rect.w <= frame.x + frame.w - inset && rect.y + rect.h <= frame.y + frame.h - inset;
}

function circleInFrame(circle: Circle, frame: Rect, inset: number): boolean {
  return circle.cx - circle.r >= frame.x + inset && circle.cy - circle.r >= frame.y + inset &&
    circle.cx + circle.r <= frame.x + frame.w - inset && circle.cy + circle.r <= frame.y + frame.h - inset;
}

function circleRectOverlap(circle: Circle, rect: Rect, gap = 0): boolean {
  const closestX = Math.max(rect.x, Math.min(circle.cx, rect.x + rect.w));
  const closestY = Math.max(rect.y, Math.min(circle.cy, rect.y + rect.h));
  return Math.hypot(circle.cx - closestX, circle.cy - closestY) < circle.r + gap;
}

function ellipseValue(x: number, y: number, rx: number, ry: number): number {
  return (x * x) / (rx * rx) + (y * y) / (ry * ry);
}

function circleFitsOrbit(circle: Circle, orbit: SceneOrbit): boolean {
  const x = circle.cx - orbit.cx;
  const y = circle.cy - orbit.cy;
  const outerRx = orbit.outerRx - circle.r;
  const outerRy = orbit.outerRy - circle.r;
  if (!(outerRx > 0 && outerRy > 0) || ellipseValue(x, y, outerRx, outerRy) > 1) return false;
  if (orbit.innerRx === 0) return true;
  return ellipseValue(x, y, orbit.innerRx + circle.r, orbit.innerRy + circle.r) >= 1;
}

function violation(code: ViolationCode, ids: readonly string[], message: string): SceneViolation {
  return { code, ids, message };
}

function sorted<T extends { id: string }>(values: readonly T[] | undefined): T[] {
  return [...(values ?? [])].sort((a, b) => stableCompare(a.id, b.id));
}

function reservedAllows(region: ReservedRegion, annotation: PlacedAnnotation): boolean {
  return region.allowedAnnotationIds?.includes(annotation.id) === true || region.allowedClassIds?.includes(annotation.classId) === true;
}

export function validateAnnotationScene(
  scene: AnnotationScene,
  policy: AnnotationPolicy = {},
): SceneViolation[] {
  const bubbleGap = policy.bubbleGap ?? 2.5;
  const labelGap = policy.labelGap ?? 1;
  const frameInset = policy.frameInset ?? 0;
  const circles = sorted(scene.circles);
  const rectangles = sorted(scene.rectangles);
  const reserved = sorted(scene.reservedRegions);
  const annotations = sorted(scene.annotations);
  const violations: SceneViolation[] = [];
  const geometryIds = [...circles, ...rectangles, ...reserved].map((item) => item.id);
  const seen = new Set<string>();
  for (const id of geometryIds) {
    if (seen.has(id)) violations.push(violation("duplicate-id", [id], `duplicate scene geometry id: ${id}`));
    seen.add(id);
  }

  if (!finite([scene.frame.x, scene.frame.y, scene.frame.w, scene.frame.h]) || scene.frame.w <= 0 || scene.frame.h <= 0) {
    return [violation("invalid-geometry", ["frame"], "frame has non-finite or non-positive geometry")];
  }

  for (const circle of circles) {
    if (!finite([circle.cx, circle.cy, circle.r])) violations.push(violation("non-finite", [circle.id], `${circle.id}: non-finite circle geometry`));
    else if (circle.r < 0) violations.push(violation("invalid-geometry", [circle.id], `${circle.id}: negative circle radius`));
    else if (!circleInFrame(circle, scene.frame, frameInset)) violations.push(violation("frame-bound", [circle.id], `${circle.id}: circle crosses frame bounds`));
  }
  for (const rect of [...rectangles, ...reserved]) {
    if (!finite([rect.x, rect.y, rect.w, rect.h])) violations.push(violation("non-finite", [rect.id], `${rect.id}: non-finite rectangle geometry`));
    else if (rect.w < 0 || rect.h < 0) violations.push(violation("invalid-geometry", [rect.id], `${rect.id}: negative rectangle extent`));
    else if (!rectInFrame(rect, scene.frame, frameInset)) violations.push(violation("frame-bound", [rect.id], `${rect.id}: rectangle crosses frame bounds`));
  }
  for (const orbit of sorted(scene.orbits)) {
    if (!finite([orbit.cx, orbit.cy, orbit.innerRx, orbit.innerRy, orbit.outerRx, orbit.outerRy])) {
      violations.push(violation("non-finite", [orbit.id], `${orbit.id}: non-finite orbit geometry`));
      continue;
    }
    if (orbit.innerRx < 0 || orbit.innerRy < 0 || orbit.outerRx <= orbit.innerRx || orbit.outerRy <= orbit.innerRy) {
      violations.push(violation("invalid-geometry", [orbit.id], `${orbit.id}: invalid inner/outer radii`));
      continue;
    }
    const orbitRect = { x: orbit.cx - orbit.outerRx, y: orbit.cy - orbit.outerRy, w: orbit.outerRx * 2, h: orbit.outerRy * 2 };
    if (!rectInFrame(orbitRect, scene.frame, frameInset)) violations.push(violation("frame-bound", [orbit.id], `${orbit.id}: orbit crosses frame bounds`));
    for (const circleId of [...orbit.circleIds].sort(stableCompare)) {
      const circle = circles.find((item) => item.id === circleId);
      if (!circle) {
        violations.push(violation("invalid-geometry", [orbit.id, circleId], `${orbit.id}: missing circle ${circleId}`));
      } else if (finite([circle.cx, circle.cy, circle.r]) && !circleFitsOrbit(circle, orbit)) {
        violations.push(violation("orbit-bound", [circleId, orbit.id], `${circleId}: escapes orbit ${orbit.id}`));
      }
    }
  }

  for (let i = 0; i < circles.length; i++) {
    for (let j = i + 1; j < circles.length; j++) {
      const a = circles[i];
      const b = circles[j];
      if (!finite([a.cx, a.cy, a.r, b.cx, b.cy, b.r])) continue;
      const bothBubbles = (a.role ?? "obstacle") === "bubble" && (b.role ?? "obstacle") === "bubble";
      const gap = bothBubbles ? bubbleGap : 0;
      // `gap` is the minimum *legal* separation, so a pair placed at exactly
      // that distance must pass. The map's hero pair is constructed at precisely
      // `r0 + r1 + bubbleGap` from two area-weighted divisions, which rounds 1-2
      // ULP short for many radius pairs; a strict `<` then reported a collision
      // the layout had built to spec. Tolerance is relative so it stays ~1e-7px
      // at poster coordinates.
      const minimumSeparation = a.r + b.r + gap;
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) < minimumSeparation * (1 - 1e-9)) {
        const code = bothBubbles ? "bubble-bubble" : "circle-circle";
        violations.push(violation(code, [a.id, b.id], `${code}: ${a.id} / ${b.id}`));
      }
    }
  }
  for (const circle of circles) {
    for (const rect of rectangles) {
      if (circleRectOverlap(circle, rect)) violations.push(violation("circle-rectangle", [circle.id, rect.id], `circle-rectangle: ${circle.id} / ${rect.id}`));
    }
    for (const region of reserved) {
      if (circleRectOverlap(circle, region)) violations.push(violation("reserved-circle", [region.id, circle.id], `reserved-circle: ${region.id} / ${circle.id}`));
    }
  }
  for (let i = 0; i < rectangles.length; i++) {
    for (let j = i + 1; j < rectangles.length; j++) {
      if (rectsOverlap(rectangles[i], rectangles[j])) violations.push(violation("rectangle-rectangle", [rectangles[i].id, rectangles[j].id], `rectangle-rectangle: ${rectangles[i].id} / ${rectangles[j].id}`));
    }
    for (const region of reserved) {
      if (rectsOverlap(rectangles[i], region)) violations.push(violation("reserved-rectangle", [region.id, rectangles[i].id], `reserved-rectangle: ${region.id} / ${rectangles[i].id}`));
    }
  }
  for (let i = 0; i < reserved.length; i++) {
    for (let j = i + 1; j < reserved.length; j++) {
      if (rectsOverlap(reserved[i], reserved[j])) violations.push(violation("reserved-rectangle", [reserved[i].id, reserved[j].id], `reserved-rectangle: ${reserved[i].id} / ${reserved[j].id}`));
    }
  }
  for (let i = 0; i < annotations.length; i++) {
    const annotation = annotations[i];
    if (!finite([annotation.bounds.x, annotation.bounds.y, annotation.bounds.w, annotation.bounds.h]) || annotation.bounds.w < 0 || annotation.bounds.h < 0) {
      violations.push(violation("invalid-geometry", [annotation.id], `${annotation.id}: invalid annotation bounds`));
      continue;
    }
    if (!rectInFrame(annotation.bounds, scene.frame, frameInset)) violations.push(violation("frame-bound", [annotation.id], `${annotation.id}: label crosses frame bounds`));
    for (let j = i + 1; j < annotations.length; j++) {
      if (rectsOverlap(annotation.bounds, annotations[j].bounds, labelGap)) violations.push(violation("label-label", [annotation.id, annotations[j].id], `label-label: ${annotation.id} / ${annotations[j].id}`));
    }
    for (const circle of circles) {
      if (circleRectOverlap(circle, annotation.bounds, labelGap)) {
        const code = (circle.role ?? "obstacle") === "bubble" ? "label-bubble" : "label-circle";
        violations.push(violation(code, [annotation.id, circle.id], `${code}: ${annotation.id} / ${circle.id}`));
      }
    }
    for (const rect of rectangles) {
      if (rect.role !== "decoration" && rectsOverlap(annotation.bounds, rect, labelGap)) violations.push(violation("label-rectangle", [annotation.id, rect.id], `label-rectangle: ${annotation.id} / ${rect.id}`));
    }
    for (const region of reserved) {
      if (!reservedAllows(region, annotation) && rectsOverlap(annotation.bounds, region, labelGap)) violations.push(violation("label-reserved", [annotation.id, region.id], `label-reserved: ${annotation.id} / ${region.id}`));
    }
  }
  return violations;
}
