/**
 * Runtime-neutral annotation planning and composition validation for static maps.
 *
 * Production callers should inject browser-measured text extents through
 * AnnotationPolicy.measureText. estimateMonospaceText() is deliberately a
 * conservative test seam, not a substitute for SVG getBBox() at render time.
 */

export interface Point {
  x: number;
  y: number;
}

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

export interface LineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SceneCircle extends Circle {
  id: string;
  role?: "bubble" | "obstacle";
}

export interface SceneRectangle extends Rect {
  id: string;
  role?: "obstacle" | "decoration";
}

export interface SceneLine extends LineSegment {
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

export type AnnotationExclusion =
  | ({ kind: "circle"; id: string } & Circle)
  | ({ kind: "rectangle"; id: string } & Rect)
  | ({ kind: "segment"; id: string } & LineSegment);

export interface AnnotationText {
  text: string;
  fontSize: number;
  fontFamily?: string;
  fontWeight?: number;
  letterSpacing?: number;
  lineHeight?: number;
}

export interface TextExtent {
  width: number;
  height: number;
}

export type TextMeasurer = (annotationId: string, text: AnnotationText) => TextExtent;

export interface AnnotationCandidate {
  id: string;
  anchor: Point;
  horizontal: "start" | "middle" | "end";
  vertical: "top" | "middle" | "bottom";
  preference?: number;
  leaderSegments?: readonly LineSegment[];
  ignoreLeaderCircleIds?: readonly string[];
  region?: AnnularRegion;
}

export interface Annotation {
  id: string;
  classId: string;
  priority: number;
  required: boolean;
  candidates: readonly AnnotationCandidate[];
  text?: AnnotationText;
  /** Fixed extent for composite annotations such as a legend or story card. */
  bounds?: { w: number; h: number };
  padding?: number;
  excludes?: readonly AnnotationExclusion[];
}

export interface PlacedAnnotation extends Omit<Annotation, "candidates" | "bounds"> {
  candidateId: string;
  bounds: Rect;
  leaderSegments: readonly LineSegment[];
  ignoreLeaderCircleIds: readonly string[];
}

export interface AnnotationScene {
  frame: Rect;
  circles?: readonly SceneCircle[];
  rectangles?: readonly SceneRectangle[];
  lines?: readonly SceneLine[];
  reservedRegions?: readonly ReservedRegion[];
  orbits?: readonly SceneOrbit[];
  annotations?: readonly PlacedAnnotation[];
}

export interface AnnotationPlanningScene extends AnnotationScene {
  annotationRequests: readonly Annotation[];
}

export interface AnnotationPolicy {
  /** Inject a lookup backed by Playwright SVG getBBox() measurements in production. */
  measureText: TextMeasurer;
  bubbleGap?: number;
  labelGap?: number;
  leaderGap?: number;
  frameInset?: number;
  maxSearchNodes?: number;
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
  | "line-circle"
  | "line-rectangle"
  | "line-line"
  | "reserved-circle"
  | "reserved-rectangle"
  | "label-label"
  | "label-bubble"
  | "label-circle"
  | "label-rectangle"
  | "label-line"
  | "label-reserved"
  | "leader-bubble"
  | "leader-circle"
  | "leader-rectangle"
  | "leader-reserved"
  | "leader-label"
  | "leader-line"
  | "leader-leader"
  | "annotation-exclusion";

export interface SceneViolation {
  code: ViolationCode;
  ids: readonly string[];
  message: string;
}

export interface DroppedAnnotation {
  id: string;
  classId: string;
  priority: number;
  reason: "class-degraded" | "class-unplaceable" | "required-failure";
  detail: string;
}

export interface ClassDegradation {
  classId: string;
  requestedCount: number;
  placedCount: number;
  attempts: readonly number[];
  droppedIds: readonly string[];
  reason: string;
}

export type AnnotationPlanResult =
  | {
      ok: true;
      placed: readonly PlacedAnnotation[];
      dropped: readonly DroppedAnnotation[];
      degradations: readonly ClassDegradation[];
      violations: readonly [];
    }
  | {
      ok: false;
      placed: readonly PlacedAnnotation[];
      dropped: readonly DroppedAnnotation[];
      degradations: readonly ClassDegradation[];
      violations: readonly SceneViolation[];
      failure: {
        kind: "invalid-scene" | "required-annotation-unplaced";
        annotationId?: string;
        detail: string;
      };
    };

export interface AnnularRegion {
  cx: number;
  cy: number;
  innerRx: number;
  innerRy: number;
  outerRx: number;
  outerRy: number;
}

export function estimateMonospaceText(_annotationId: string, text: AnnotationText): TextExtent {
  const lines = text.text.split("\n");
  const widest = Math.max(0, ...lines.map((line) => line.length));
  const tracking = Math.max(widest - 1, 0) * (text.letterSpacing ?? 0);
  return {
    width: widest * text.fontSize * 0.68 + tracking,
    height: Math.max(lines.length, 1) * (text.lineHeight ?? text.fontSize * 1.35),
  };
}

function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finite(values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

function inflate(rect: Rect, amount: number): Rect {
  return { x: rect.x - amount, y: rect.y - amount, w: rect.w + amount * 2, h: rect.h + amount * 2 };
}

function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

function pointInRect(point: Point, rect: Rect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}

function rectInFrame(rect: Rect, frame: Rect, inset: number): boolean {
  return rect.x >= frame.x + inset && rect.y >= frame.y + inset &&
    rect.x + rect.w <= frame.x + frame.w - inset && rect.y + rect.h <= frame.y + frame.h - inset;
}

function circleInFrame(circle: Circle, frame: Rect, inset: number): boolean {
  return circle.cx - circle.r >= frame.x + inset && circle.cy - circle.r >= frame.y + inset &&
    circle.cx + circle.r <= frame.x + frame.w - inset && circle.cy + circle.r <= frame.y + frame.h - inset;
}

function segmentInFrame(segment: LineSegment, frame: Rect, inset: number): boolean {
  return pointInRect({ x: segment.x1, y: segment.y1 }, inflate(frame, -inset)) &&
    pointInRect({ x: segment.x2, y: segment.y2 }, inflate(frame, -inset));
}

function circleRectOverlap(circle: Circle, rect: Rect, gap = 0): boolean {
  const closestX = Math.max(rect.x, Math.min(circle.cx, rect.x + rect.w));
  const closestY = Math.max(rect.y, Math.min(circle.cy, rect.y + rect.h));
  return Math.hypot(circle.cx - closestX, circle.cy - closestY) < circle.r + gap;
}

function distancePointToSegment(point: Point, segment: LineSegment): number {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - segment.x1, point.y - segment.y1);
  const t = Math.max(0, Math.min(1, ((point.x - segment.x1) * dx + (point.y - segment.y1) * dy) / lengthSquared));
  return Math.hypot(point.x - (segment.x1 + t * dx), point.y - (segment.y1 + t * dy));
}

function orientation(a: Point, b: Point, c: Point): number {
  const value = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.abs(value) < 1e-9 ? 0 : value > 0 ? 1 : -1;
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return orientation(a, b, p) === 0 && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) &&
    p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}

function segmentsIntersect(a: LineSegment, b: LineSegment): boolean {
  const a1 = { x: a.x1, y: a.y1 };
  const a2 = { x: a.x2, y: a.y2 };
  const b1 = { x: b.x1, y: b.y1 };
  const b2 = { x: b.x2, y: b.y2 };
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSegment(a1, a2, b1)) || (o2 === 0 && onSegment(a1, a2, b2)) ||
    (o3 === 0 && onSegment(b1, b2, a1)) || (o4 === 0 && onSegment(b1, b2, a2));
}

function segmentRectOverlap(segment: LineSegment, rect: Rect): boolean {
  if (pointInRect({ x: segment.x1, y: segment.y1 }, rect) || pointInRect({ x: segment.x2, y: segment.y2 }, rect)) return true;
  const edges: LineSegment[] = [
    { x1: rect.x, y1: rect.y, x2: rect.x + rect.w, y2: rect.y },
    { x1: rect.x + rect.w, y1: rect.y, x2: rect.x + rect.w, y2: rect.y + rect.h },
    { x1: rect.x + rect.w, y1: rect.y + rect.h, x2: rect.x, y2: rect.y + rect.h },
    { x1: rect.x, y1: rect.y + rect.h, x2: rect.x, y2: rect.y },
  ];
  return edges.some((edge) => segmentsIntersect(segment, edge));
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

function rectFitsAnnulus(rect: Rect, region: AnnularRegion): boolean {
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h },
    { x: rect.x, y: rect.y + rect.h },
  ];
  const insideOuter = corners.every((point) => {
    const x = point.x - region.cx;
    const y = point.y - region.cy;
    return ellipseValue(x, y, region.outerRx, region.outerRy) <= 1;
  });
  if (!insideOuter || region.innerRx === 0) return insideOuter;
  const nearestX = Math.max(rect.x, Math.min(region.cx, rect.x + rect.w)) - region.cx;
  const nearestY = Math.max(rect.y, Math.min(region.cy, rect.y + rect.h)) - region.cy;
  return ellipseValue(nearestX, nearestY, region.innerRx, region.innerRy) >= 1;
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
  policy: Pick<AnnotationPolicy, "bubbleGap" | "labelGap" | "leaderGap" | "frameInset"> = {},
): SceneViolation[] {
  const bubbleGap = policy.bubbleGap ?? 2.5;
  const labelGap = policy.labelGap ?? 1;
  const leaderGap = policy.leaderGap ?? 1;
  const frameInset = policy.frameInset ?? 0;
  const circles = sorted(scene.circles);
  const rectangles = sorted(scene.rectangles);
  const lines = sorted(scene.lines);
  const reserved = sorted(scene.reservedRegions);
  const annotations = sorted(scene.annotations);
  const violations: SceneViolation[] = [];
  const geometryIds = [...circles, ...rectangles, ...lines, ...reserved].map((item) => item.id);
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
  for (const line of lines) {
    if (!finite([line.x1, line.y1, line.x2, line.y2])) violations.push(violation("non-finite", [line.id], `${line.id}: non-finite line geometry`));
    else if (!segmentInFrame(line, scene.frame, frameInset)) violations.push(violation("frame-bound", [line.id], `${line.id}: line crosses frame bounds`));
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
  for (const line of lines) {
    for (const circle of circles) {
      if (distancePointToSegment({ x: circle.cx, y: circle.cy }, line) < circle.r) violations.push(violation("line-circle", [line.id, circle.id], `line-circle: ${line.id} / ${circle.id}`));
    }
    for (const rect of [...rectangles, ...reserved]) {
      if (segmentRectOverlap(line, rect)) violations.push(violation("line-rectangle", [line.id, rect.id], `line-rectangle: ${line.id} / ${rect.id}`));
    }
  }
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (segmentsIntersect(lines[i], lines[j])) violations.push(violation("line-line", [lines[i].id, lines[j].id], `line-line: ${lines[i].id} / ${lines[j].id}`));
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
    for (const line of lines) {
      if (line.role !== "decoration" && segmentRectOverlap(line, inflate(annotation.bounds, labelGap))) violations.push(violation("label-line", [annotation.id, line.id], `label-line: ${annotation.id} / ${line.id}`));
    }
    for (const exclusion of [...(annotation.excludes ?? [])].sort((a, b) => stableCompare(a.id, b.id))) {
      const hit = exclusion.kind === "circle"
        ? circleRectOverlap(exclusion, annotation.bounds, labelGap)
        : exclusion.kind === "rectangle"
          ? rectsOverlap(exclusion, annotation.bounds, labelGap)
          : segmentRectOverlap(exclusion, annotation.bounds);
      if (hit) violations.push(violation("annotation-exclusion", [annotation.id, exclusion.id], `annotation-exclusion: ${annotation.id} / ${exclusion.id}`));
    }

    for (const [segmentIndex, segment] of annotation.leaderSegments.entries()) {
      const leaderId = `${annotation.id}:leader:${segmentIndex}`;
      if (!finite([segment.x1, segment.y1, segment.x2, segment.y2])) {
        violations.push(violation("non-finite", [leaderId], `${leaderId}: non-finite leader geometry`));
        continue;
      }
      if (!segmentInFrame(segment, scene.frame, frameInset)) violations.push(violation("frame-bound", [leaderId], `${leaderId}: leader crosses frame bounds`));
      for (const circle of circles) {
        if (annotation.ignoreLeaderCircleIds.includes(circle.id)) continue;
        if (distancePointToSegment({ x: circle.cx, y: circle.cy }, segment) < circle.r + leaderGap) {
          const code = (circle.role ?? "obstacle") === "bubble" ? "leader-bubble" : "leader-circle";
          violations.push(violation(code, [leaderId, circle.id], `${code}: ${leaderId} / ${circle.id}`));
        }
      }
      for (const other of annotations) {
        if (other.id === annotation.id) continue;
        if (segmentRectOverlap(segment, inflate(other.bounds, leaderGap))) violations.push(violation("leader-label", [leaderId, other.id], `leader-label: ${leaderId} / ${other.id}`));
      }
      for (const line of lines) {
        if (line.role !== "decoration" && segmentsIntersect(segment, line)) violations.push(violation("leader-line", [leaderId, line.id], `leader-line: ${leaderId} / ${line.id}`));
      }
      for (const rect of rectangles) {
        if (rect.role !== "decoration" && segmentRectOverlap(segment, inflate(rect, leaderGap))) violations.push(violation("leader-rectangle", [leaderId, rect.id], `leader-rectangle: ${leaderId} / ${rect.id}`));
      }
      for (const region of reserved) {
        if (!reservedAllows(region, annotation) && segmentRectOverlap(segment, inflate(region, leaderGap))) violations.push(violation("leader-reserved", [leaderId, region.id], `leader-reserved: ${leaderId} / ${region.id}`));
      }
      for (const exclusion of [...(annotation.excludes ?? [])].sort((a, b) => stableCompare(a.id, b.id))) {
        const hit = exclusion.kind === "circle"
          ? distancePointToSegment({ x: exclusion.cx, y: exclusion.cy }, segment) < exclusion.r + leaderGap
          : exclusion.kind === "rectangle"
            ? segmentRectOverlap(segment, inflate(exclusion, leaderGap))
            : segmentsIntersect(segment, exclusion);
        if (hit) violations.push(violation("annotation-exclusion", [leaderId, exclusion.id], `annotation-exclusion: ${leaderId} / ${exclusion.id}`));
      }
    }
  }
  for (let i = 0; i < annotations.length; i++) {
    for (let j = i + 1; j < annotations.length; j++) {
      for (const [aIndex, a] of annotations[i].leaderSegments.entries()) {
        for (const [bIndex, b] of annotations[j].leaderSegments.entries()) {
          if (segmentsIntersect(a, b)) {
            const aId = `${annotations[i].id}:leader:${aIndex}`;
            const bId = `${annotations[j].id}:leader:${bIndex}`;
            violations.push(violation("leader-leader", [aId, bId], `leader-leader: ${aId} / ${bId}`));
          }
        }
      }
    }
  }
  return violations;
}

function extentOf(annotation: Annotation, measureText: TextMeasurer): TextExtent {
  if (annotation.bounds) return { width: annotation.bounds.w, height: annotation.bounds.h };
  if (!annotation.text) return { width: Number.NaN, height: Number.NaN };
  return measureText(annotation.id, annotation.text);
}

function placementOf(annotation: Annotation, candidate: AnnotationCandidate, measureText: TextMeasurer): PlacedAnnotation {
  const { candidates: _candidates, bounds: _fixedBounds, ...model } = annotation;
  const extent = extentOf(annotation, measureText);
  const padding = annotation.padding ?? 0;
  const w = extent.width + padding * 2;
  const h = extent.height + padding * 2;
  const x = candidate.horizontal === "start" ? candidate.anchor.x : candidate.horizontal === "middle" ? candidate.anchor.x - w / 2 : candidate.anchor.x - w;
  const y = candidate.vertical === "top" ? candidate.anchor.y : candidate.vertical === "middle" ? candidate.anchor.y - h / 2 : candidate.anchor.y - h;
  return {
    ...model,
    excludes: [...(annotation.excludes ?? [])].sort((a, b) => stableCompare(a.id, b.id)),
    candidateId: candidate.id,
    bounds: { x, y, w, h },
    leaderSegments: [...(candidate.leaderSegments ?? [])],
    ignoreLeaderCircleIds: [...(candidate.ignoreLeaderCircleIds ?? [])],
  };
}

function annotationOrder(a: Annotation, b: Annotation): number {
  return b.priority - a.priority || stableCompare(a.id, b.id);
}

function candidateOrder(a: AnnotationCandidate, b: AnnotationCandidate): number {
  return (a.preference ?? 0) - (b.preference ?? 0) || stableCompare(a.id, b.id);
}

function newViolations(scene: AnnotationScene, placed: readonly PlacedAnnotation[], policy: AnnotationPolicy): SceneViolation[] {
  return validateAnnotationScene({ ...scene, annotations: [...(scene.annotations ?? []), ...placed] }, policy);
}

function solveGroup(
  annotations: readonly Annotation[],
  scene: AnnotationScene,
  fixed: readonly PlacedAnnotation[],
  policy: AnnotationPolicy,
  search: { nodes: number },
): { placed: PlacedAnnotation[]; lastViolations: SceneViolation[]; exhausted: boolean } | null {
  let lastViolations: SceneViolation[] = [];
  let exhausted = false;
  const maxNodes = policy.maxSearchNodes ?? 50_000;
  const visit = (index: number, current: PlacedAnnotation[]): PlacedAnnotation[] | null => {
    if (index === annotations.length) return current;
    const annotation = annotations[index];
    for (const candidate of [...annotation.candidates].sort(candidateOrder)) {
      search.nodes += 1;
      if (search.nodes > maxNodes) {
        exhausted = true;
        return null;
      }
      const placement = placementOf(annotation, candidate, policy.measureText);
      if (candidate.region && !rectFitsAnnulus(placement.bounds, candidate.region)) {
        lastViolations = [violation("annotation-exclusion", [annotation.id, candidate.id], `${annotation.id}: candidate ${candidate.id} escapes its annular region`)];
        continue;
      }
      const trial = [...fixed, ...current, placement];
      const violations = newViolations(scene, trial, policy);
      if (violations.length > 0) {
        lastViolations = violations;
        continue;
      }
      const result = visit(index + 1, [...current, placement]);
      if (result) return result;
      if (exhausted) return null;
    }
    return null;
  };
  const placed = visit(0, []);
  return placed ? { placed, lastViolations: [], exhausted: false } : lastViolations.length > 0 || exhausted ? { placed: [], lastViolations, exhausted } : null;
}

export function planAnnotations(
  scene: AnnotationPlanningScene,
  policy: AnnotationPolicy,
): AnnotationPlanResult {
  const annotations = scene.annotationRequests;
  const baseViolations = validateAnnotationScene(scene, policy);
  if (baseViolations.length > 0) {
    return {
      ok: false,
      placed: [],
      dropped: [],
      degradations: [],
      violations: baseViolations,
      failure: { kind: "invalid-scene", detail: "The unannotated scene is invalid." },
    };
  }
  const duplicateAnnotationIds = annotations.map((item) => item.id).sort(stableCompare).filter((id, index, ids) => index > 0 && id === ids[index - 1]);
  if (duplicateAnnotationIds.length > 0) {
    const violations = duplicateAnnotationIds.map((id) => violation("duplicate-id", [id], `duplicate annotation id: ${id}`));
    return {
      ok: false,
      placed: [],
      dropped: [],
      degradations: [],
      violations,
      failure: { kind: "invalid-scene", detail: "Annotation ids must be unique." },
    };
  }

  const extentCache: Record<string, TextExtent> = {};
  const measuredPolicy: AnnotationPolicy = {
    ...policy,
    measureText: (annotationId, text) => {
      const cached = extentCache[annotationId];
      if (cached) return cached;
      const extent = policy.measureText(annotationId, text);
      extentCache[annotationId] = extent;
      return extent;
    },
  };
  const requestViolations: SceneViolation[] = [];
  for (const annotation of [...annotations].sort((a, b) => stableCompare(a.id, b.id))) {
    if (!annotation.id || !annotation.classId || !Number.isFinite(annotation.priority)) {
      requestViolations.push(violation("invalid-geometry", [annotation.id || "annotation"], `${annotation.id || "annotation"}: invalid id, class, or priority`));
    }
    const extent = extentOf(annotation, measuredPolicy.measureText);
    if (!finite([extent.width, extent.height]) || extent.width < 0 || extent.height < 0) {
      requestViolations.push(violation("invalid-geometry", [annotation.id], `${annotation.id}: measured text or fixed bounds have invalid extents`));
    }
    const candidateIds = annotation.candidates.map((item) => item.id).sort(stableCompare);
    for (let index = 1; index < candidateIds.length; index++) {
      if (candidateIds[index] === candidateIds[index - 1]) requestViolations.push(violation("duplicate-id", [annotation.id, candidateIds[index]], `${annotation.id}: duplicate candidate id ${candidateIds[index]}`));
    }
    for (const candidate of [...annotation.candidates].sort((a, b) => stableCompare(a.id, b.id))) {
      const segmentValues = (candidate.leaderSegments ?? []).flatMap((segment) => [segment.x1, segment.y1, segment.x2, segment.y2]);
      if (!candidate.id || !finite([candidate.anchor.x, candidate.anchor.y, candidate.preference ?? 0, ...segmentValues])) {
        requestViolations.push(violation("non-finite", [annotation.id, candidate.id || "candidate"], `${annotation.id}: candidate ${candidate.id || "candidate"} has invalid geometry`));
      }
      if (candidate.region && (
        !finite([candidate.region.cx, candidate.region.cy, candidate.region.innerRx, candidate.region.innerRy, candidate.region.outerRx, candidate.region.outerRy]) ||
        candidate.region.innerRx < 0 || candidate.region.innerRy < 0 ||
        candidate.region.outerRx <= candidate.region.innerRx || candidate.region.outerRy <= candidate.region.innerRy
      )) {
        requestViolations.push(violation("invalid-geometry", [annotation.id, candidate.id], `${annotation.id}: candidate ${candidate.id} has an invalid annular region`));
      }
    }
  }
  if (requestViolations.length > 0) {
    return {
      ok: false,
      placed: [],
      dropped: [],
      degradations: [],
      violations: requestViolations,
      failure: { kind: "invalid-scene", detail: "Annotation requests contain invalid or non-deterministic geometry." },
    };
  }

  const required = annotations.filter((item) => item.required).sort(annotationOrder);
  const requiredResult = solveGroup(required, scene, [], measuredPolicy, { nodes: 0 });
  if (!requiredResult || requiredResult.placed.length !== required.length) {
    const failed = required.find((item) => !requiredResult?.placed.some((placed) => placed.id === item.id));
    const detail = requiredResult?.exhausted
      ? `Required annotation search exceeded ${measuredPolicy.maxSearchNodes ?? 50_000} candidates.`
      : `Required annotation ${failed?.id ?? "unknown"} has no collision-free candidate.`;
    return {
      ok: false,
      placed: [],
      dropped: failed ? [{ id: failed.id, classId: failed.classId, priority: failed.priority, reason: "required-failure", detail }] : [],
      degradations: [],
      violations: requiredResult?.lastViolations ?? [],
      failure: { kind: "required-annotation-unplaced", annotationId: failed?.id, detail },
    };
  }

  const placed = [...requiredResult.placed];
  const dropped: DroppedAnnotation[] = [];
  const degradations: ClassDegradation[] = [];
  const optionalByClass: Record<string, Annotation[]> = {};
  for (const annotation of annotations.filter((item) => !item.required)) {
    (optionalByClass[annotation.classId] ??= []).push(annotation);
  }
  const classIds = Object.keys(optionalByClass).sort((a, b) => {
    const aItems = optionalByClass[a].sort(annotationOrder);
    const bItems = optionalByClass[b].sort(annotationOrder);
    return annotationOrder(aItems[0], bItems[0]) || stableCompare(a, b);
  });
  for (const classId of classIds) {
    const items = optionalByClass[classId].sort(annotationOrder);
    const attempts: number[] = [];
    let selected: PlacedAnnotation[] | null = null;
    let placedCount = 0;
    let failureDetail = "no non-empty priority prefix had candidates";
    for (let count = items.length; count >= 0; count--) {
      attempts.push(count);
      if (count === 0) {
        selected = [];
        break;
      }
      const result = solveGroup(items.slice(0, count), scene, placed, measuredPolicy, { nodes: 0 });
      if (result && result.placed.length === count) {
        selected = result.placed;
        placedCount = count;
        break;
      }
      if (result?.exhausted) {
        failureDetail = `search exceeded ${measuredPolicy.maxSearchNodes ?? 50_000} candidates`;
      } else if (result?.lastViolations.length) {
        const collisionCodes = [...new Set(result.lastViolations.map((item) => item.code))].sort(stableCompare);
        failureDetail = `candidate layouts failed: ${collisionCodes.join(", ")}`;
      }
    }
    placed.push(...(selected ?? []));
    const omitted = items.slice(placedCount);
    for (const item of omitted) {
      dropped.push({
        id: item.id,
        classId,
        priority: item.priority,
        reason: placedCount === 0 ? "class-unplaceable" : "class-degraded",
        detail: placedCount === 0
          ? `Optional class ${classId} degraded from ${items.length} to zero: ${failureDetail}.`
          : `Optional class ${classId} degraded from ${items.length} to ${placedCount} after ${failureDetail}; ${item.id} was outside the retained priority prefix.`,
      });
    }
    if (omitted.length > 0) {
      degradations.push({
        classId,
        requestedCount: items.length,
        placedCount,
        attempts,
        droppedIds: omitted.map((item) => item.id),
        reason: placedCount === 0 ? failureDetail : `the first collision-free priority prefix was retained after ${failureDetail}`,
      });
    }
  }
  return { ok: true, placed, dropped, degradations, violations: [] };
}

export function bubbleQuadrantCandidates(input: {
  bubble: Circle & { id: string };
  gap?: number;
  leader?: boolean;
}): AnnotationCandidate[] {
  const gap = input.gap ?? 8;
  const diagonal = input.bubble.r + gap;
  const quadrants = [
    { id: "ne", sx: 1, sy: -1, horizontal: "start" as const, vertical: "bottom" as const },
    { id: "se", sx: 1, sy: 1, horizontal: "start" as const, vertical: "top" as const },
    { id: "nw", sx: -1, sy: -1, horizontal: "end" as const, vertical: "bottom" as const },
    { id: "sw", sx: -1, sy: 1, horizontal: "end" as const, vertical: "top" as const },
  ];
  return quadrants.map((quadrant, index) => {
    const anchor = { x: input.bubble.cx + quadrant.sx * diagonal, y: input.bubble.cy + quadrant.sy * diagonal };
    const length = Math.hypot(anchor.x - input.bubble.cx, anchor.y - input.bubble.cy);
    const rim = {
      x: input.bubble.cx + ((anchor.x - input.bubble.cx) / length) * input.bubble.r,
      y: input.bubble.cy + ((anchor.y - input.bubble.cy) / length) * input.bubble.r,
    };
    return {
      id: `${input.bubble.id}:${quadrant.id}`,
      anchor,
      horizontal: quadrant.horizontal,
      vertical: quadrant.vertical,
      preference: index,
      leaderSegments: input.leader === false ? [] : [{ x1: rim.x, y1: rim.y, x2: anchor.x, y2: anchor.y }],
      ignoreLeaderCircleIds: [input.bubble.id],
    };
  });
}

export function annularSectorCandidates(input: AnnularRegion & {
  id: string;
  startAngle: number;
  endAngle: number;
  angularSteps?: number;
  radialFractions?: readonly number[];
}): AnnotationCandidate[] {
  const angularSteps = Math.max(1, Math.floor(input.angularSteps ?? 5));
  const radialFractions = [...(input.radialFractions ?? [0.5])].sort((a, b) => a - b);
  const region: AnnularRegion = {
    cx: input.cx,
    cy: input.cy,
    innerRx: input.innerRx,
    innerRy: input.innerRy,
    outerRx: input.outerRx,
    outerRy: input.outerRy,
  };
  const candidates: AnnotationCandidate[] = [];
  for (const radial of radialFractions) {
    for (let index = 0; index < angularSteps; index++) {
      const fraction = angularSteps === 1 ? 0.5 : index / (angularSteps - 1);
      const angle = input.startAngle + (input.endAngle - input.startAngle) * fraction;
      const rx = input.innerRx + (input.outerRx - input.innerRx) * radial;
      const ry = input.innerRy + (input.outerRy - input.innerRy) * radial;
      candidates.push({
        id: `${input.id}:r${radial.toFixed(3)}:a${index}`,
        anchor: { x: input.cx + rx * Math.cos(angle), y: input.cy + ry * Math.sin(angle) },
        horizontal: "middle",
        vertical: "middle",
        preference: candidates.length,
        region,
      });
    }
  }
  return candidates;
}

export function frameRailCandidates(input: {
  id: string;
  frame: Rect;
  edge: "top" | "right" | "bottom" | "left";
  count?: number;
  from?: number;
  to?: number;
  inset?: number;
}): AnnotationCandidate[] {
  const count = Math.max(1, Math.floor(input.count ?? 3));
  const from = input.from ?? 0.1;
  const to = input.to ?? 0.9;
  const inset = input.inset ?? 0;
  const candidates: AnnotationCandidate[] = [];
  for (let index = 0; index < count; index++) {
    const progress = count === 1 ? (from + to) / 2 : from + ((to - from) * index) / (count - 1);
    if (input.edge === "top" || input.edge === "bottom") {
      candidates.push({
        id: `${input.id}:${input.edge}:${index}`,
        anchor: {
          x: input.frame.x + input.frame.w * progress,
          y: input.edge === "top" ? input.frame.y + inset : input.frame.y + input.frame.h - inset,
        },
        horizontal: "middle",
        vertical: input.edge === "top" ? "top" : "bottom",
        preference: index,
      });
    } else {
      candidates.push({
        id: `${input.id}:${input.edge}:${index}`,
        anchor: {
          x: input.edge === "left" ? input.frame.x + inset : input.frame.x + input.frame.w - inset,
          y: input.frame.y + input.frame.h * progress,
        },
        horizontal: input.edge === "left" ? "start" : "end",
        vertical: "middle",
        preference: index,
      });
    }
  }
  return candidates;
}
