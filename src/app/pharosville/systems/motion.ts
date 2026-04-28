import { nearestWaterTile } from "./world-layout";
import type { PharosVilleMap, PharosVilleWorld, ShipDockVisit, ShipNode, ShipWaterZone } from "./world-types";

export const MAX_ANIMATED_WORLD_ENTITIES = 80;

export interface ShipWaterPath {
  from: { x: number; y: number };
  to: { x: number; y: number };
  points: Array<{ x: number; y: number }>;
  cumulativeLengths: number[];
  totalLength: number;
}

export type ShipMotionState = "moored" | "departing" | "sailing" | "risk-drift" | "arriving";

export interface ShipMotionRoute {
  shipId: string;
  cycleSeconds: number;
  phaseSeconds: number;
  riskTile: { x: number; y: number };
  dockStops: Array<{
    chainId: string;
    dockId: string;
    weight: number;
    mooringTile: { x: number; y: number };
  }>;
  zone: ShipWaterZone;
  dockStopSchedule: string[];
  waterPaths: ReadonlyMap<string, ShipWaterPath>;
  routeSeed: number;
}

export interface ShipMotionSample {
  shipId: string;
  tile: { x: number; y: number };
  state: ShipMotionState;
  zone: ShipWaterZone;
  currentDockId: string | null;
  heading: { x: number; y: number };
  wakeIntensity: number;
}

export interface PharosVilleMotionPlan {
  animatedShipIds: ReadonlySet<string>;
  effectShipIds: ReadonlySet<string>;
  lighthouseFireFlickerPerSecond: number;
  moverShipIds: ReadonlySet<string>;
  shipPhases: ReadonlyMap<string, number>;
  shipRoutes: ReadonlyMap<string, ShipMotionRoute>;
}

const BAND_FIRE_FLICKER_SPEED: Record<string, number> = {
  critical: 0.18,
  danger: 0.28,
  degraded: 0.38,
  healthy: 0.52,
  stable: 0.48,
  warning: 0.32,
};

const WATER_KINDS = new Set(["water", "deep-water"]);

const ZONE_DWELL: Record<ShipWaterZone, { dockDwell: number; riskDwell: number; transit: number }> = {
  fog: { riskDwell: 0.7, dockDwell: 0.08, transit: 0.22 },
  ledger: { riskDwell: 0.6, dockDwell: 0.1, transit: 0.3 },
  muddy: { riskDwell: 0.55, dockDwell: 0.2, transit: 0.25 },
  safe: { riskDwell: 0.35, dockDwell: 0.35, transit: 0.3 },
  storm: { riskDwell: 0.78, dockDwell: 0.06, transit: 0.16 },
};

export function buildMotionPlan(world: PharosVilleWorld, selectedDetailId: string | null): PharosVilleMotionPlan {
  const selectedShip = selectedDetailId
    ? world.ships.find((ship) => ship.detailId === selectedDetailId)
    : null;
  const topShips = world.ships
    .toSorted((a, b) => b.marketCapUsd - a.marketCapUsd)
    .slice(0, 48);
  const moverShips = world.ships
    .filter(hasRecentMove)
    .toSorted((a, b) => Math.abs(b.change24hUsd ?? 0) - Math.abs(a.change24hUsd ?? 0))
    .slice(0, 16);
  const animatedShipIds = new Set<string>();
  if (selectedShip) animatedShipIds.add(selectedShip.id);
  for (const ship of topShips) {
    if (animatedShipIds.size >= MAX_ANIMATED_WORLD_ENTITIES) break;
    animatedShipIds.add(ship.id);
  }
  for (const ship of moverShips) {
    if (animatedShipIds.size >= MAX_ANIMATED_WORLD_ENTITIES) break;
    animatedShipIds.add(ship.id);
  }

  return {
    animatedShipIds,
    effectShipIds: animatedShipIds,
    lighthouseFireFlickerPerSecond: lighthouseFireFlickerSpeed(world.lighthouse.psiBand, world.lighthouse.score),
    moverShipIds: new Set(moverShips.map((ship) => ship.id)),
    shipPhases: new Map(world.ships.map((ship) => [ship.id, stableMotionPhase(ship.id)])),
    shipRoutes: new Map(world.ships.map((ship) => [ship.id, buildShipMotionRoute(ship, world.map)])),
  };
}

export function buildShipWaterRoute(input: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  map: PharosVilleMap;
}): ShipWaterPath {
  const from = nearestMapWaterTile(input.from, input.map);
  const to = nearestMapWaterTile(input.to, input.map);
  if (sameTile(from, to)) return waterPathFromPoints(from, to, [from]);

  const detouredPoints = findDetouredWaterPath(from, to, input.map);
  if (detouredPoints.length > 0) return waterPathFromPoints(from, to, detouredPoints);

  const points = findWaterPath(from, to, input.map);
  if (points.length > 0) return waterPathFromPoints(from, to, points);

  const waypoint = fallbackWaterWaypoint(from, to, input.map);
  const firstLeg = findWaterPath(from, waypoint, input.map);
  const secondLeg = findWaterPath(waypoint, to, input.map);
  if (firstLeg.length > 0 && secondLeg.length > 0) {
    return waterPathFromPoints(from, to, [...firstLeg, ...secondLeg.slice(1)]);
  }

  return waterPathFromPoints(from, to, [from]);
}

export function resolveShipMotionSample(input: {
  plan: PharosVilleMotionPlan;
  reducedMotion: boolean;
  ship: ShipNode;
  timeSeconds: number;
}): ShipMotionSample {
  const route = input.plan.shipRoutes.get(input.ship.id);
  if (input.reducedMotion || !route) {
    return {
      shipId: input.ship.id,
      tile: input.ship.tile,
      state: "risk-drift",
      zone: input.ship.riskZone,
      currentDockId: null,
      heading: { x: 0, y: 0 },
      wakeIntensity: 0,
    };
  }

  const scheduledStopCount = Math.min(dockStopCount(route.dockStops.length), route.dockStopSchedule.length);
  if (scheduledStopCount === 0) {
    return riskDriftSample(route, input.timeSeconds, 0.18);
  }

  const cyclePosition = input.timeSeconds + route.phaseSeconds;
  const elapsedSeconds = positiveModulo(cyclePosition, route.cycleSeconds);
  const cycleIndex = Math.floor(cyclePosition / route.cycleSeconds);
  const scheduleOffset = positiveModulo(cycleIndex * scheduledStopCount, route.dockStopSchedule.length);
  const zoneDwell = ZONE_DWELL[route.zone];
  const riskSeconds = route.cycleSeconds * zoneDwell.riskDwell;
  const dockSecondsEach = route.cycleSeconds * zoneDwell.dockDwell / scheduledStopCount;
  const transitSecondsEach = route.cycleSeconds * zoneDwell.transit / (scheduledStopCount * 2);
  let cursor = elapsedSeconds;

  if (cursor < riskSeconds) {
    return riskDriftSample(route, input.timeSeconds, cursor / Math.max(1, riskSeconds));
  }
  cursor -= riskSeconds;

  for (let stopIndex = 0; stopIndex < scheduledStopCount; stopIndex += 1) {
    const stop = dockStopForScheduleIndex(route, scheduleOffset + stopIndex);
    if (!stop) continue;

    if (cursor < transitSecondsEach) {
      return transitSample({
        route,
        path: route.waterPaths.get(pathKey(route.riskTile, stop.mooringTile)),
        progress: smoothstep(cursor / Math.max(1, transitSecondsEach)),
        state: "departing",
        dockId: stop.dockId,
      });
    }
    cursor -= transitSecondsEach;

    if (cursor < dockSecondsEach) {
      return {
        shipId: route.shipId,
        tile: stop.mooringTile,
        state: "moored",
        zone: route.zone,
        currentDockId: stop.dockId,
        heading: { x: 0, y: 1 },
        wakeIntensity: 0,
      };
    }
    cursor -= dockSecondsEach;

    if (cursor < transitSecondsEach) {
      return transitSample({
        route,
        path: route.waterPaths.get(pathKey(stop.mooringTile, route.riskTile)),
        progress: smoothstep(cursor / Math.max(1, transitSecondsEach)),
        state: "arriving",
        dockId: stop.dockId,
      });
    }
    cursor -= transitSecondsEach;
  }

  return riskDriftSample(route, input.timeSeconds, 1);
}

export function lighthouseFireFlickerSpeed(band: string | null, score: number | null) {
  const base = band ? BAND_FIRE_FLICKER_SPEED[band.toLowerCase()] ?? 0.34 : 0.22;
  if (score == null) return base;
  return base * (0.85 + Math.max(0, Math.min(100, score)) / 500);
}

export function stableMotionPhase(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return (hash % 628) / 100;
}

function hasRecentMove(ship: ShipNode) {
  const absolute = Math.abs(ship.change24hUsd ?? 0);
  const percentage = Math.abs(ship.change24hPct ?? 0);
  return absolute >= 1_000_000 || percentage >= 0.01;
}

function buildShipMotionRoute(ship: ShipNode, map: PharosVilleMap): ShipMotionRoute {
  const riskTile = nearestWaterTile(ship.tile);
  const dockStops = ship.dockVisits.map((visit) => ({ ...visit }));
  const cycleSeconds = shipCycleSeconds(ship);
  const waterPaths = new Map<string, ShipWaterPath>();

  for (const stop of dockStops) {
    const outbound = buildShipWaterRoute({ from: riskTile, to: stop.mooringTile, map });
    const inbound = reverseWaterPath(outbound);
    waterPaths.set(pathKey(riskTile, stop.mooringTile), outbound);
    waterPaths.set(pathKey(stop.mooringTile, riskTile), inbound);
  }

  return {
    shipId: ship.id,
    cycleSeconds,
    phaseSeconds: stableUnit(`${ship.id}.phase`) * cycleSeconds,
    riskTile,
    dockStops,
    zone: ship.riskZone,
    dockStopSchedule: weightedDockStopSchedule(ship.id, dockStops),
    waterPaths,
    routeSeed: stableHash(ship.id),
  };
}

function shipCycleSeconds(ship: ShipNode): number {
  const positiveChainCount = ship.chainPresence.length;
  const renderedDockCount = ship.dockVisits.length;
  const base = 220;
  const breadthBonus = Math.min(80, positiveChainCount * 10 + renderedDockCount * 8);
  const jitter = stableOffset(`${ship.id}.cycle`, 18);
  return clamp(base - breadthBonus + jitter, 130, 280);
}

function weightedDockStopSchedule(shipId: string, visits: readonly ShipDockVisit[]): string[] {
  if (visits.length === 0) return [];

  const sortedVisits = [...visits].sort((a, b) => b.weight - a.weight || a.dockId.localeCompare(b.dockId));
  const rotation = stableHash(`${shipId}.dock-schedule`) % sortedVisits.length;
  const rotatedUniqueVisits = [...sortedVisits.slice(rotation), ...sortedVisits.slice(0, rotation)];
  const repeated = rotatedUniqueVisits.map((visit) => visit.dockId);
  const totalWeight = sortedVisits.reduce((sum, visit) => sum + Math.max(0, visit.weight), 0);

  for (const visit of sortedVisits) {
    if (repeated.length >= 6) break;
    const normalized = totalWeight > 0 ? Math.max(0, visit.weight) / totalWeight : 1 / sortedVisits.length;
    const repeats = Math.max(0, Math.min(5, Math.round(normalized * 6) - 1));
    for (let index = 0; index < repeats && repeated.length < 6; index += 1) {
      repeated.push(visit.dockId);
    }
  }

  return repeated;
}

function dockStopForScheduleIndex(route: ShipMotionRoute, scheduleIndex: number) {
  if (route.dockStopSchedule.length === 0) return null;
  const dockId = route.dockStopSchedule[positiveModulo(scheduleIndex, route.dockStopSchedule.length)];
  return route.dockStops.find((stop) => stop.dockId === dockId) ?? null;
}

function dockStopCount(renderedDockCount: number) {
  if (renderedDockCount <= 0) return 0;
  if (renderedDockCount === 1) return 1;
  if (renderedDockCount <= 3) return 2;
  return 3;
}

function findDetouredWaterPath(from: { x: number; y: number }, to: { x: number; y: number }, map: PharosVilleMap): Array<{ x: number; y: number }> {
  const waypoints = detourWaterWaypoints(from, to, map);
  if (waypoints.length === 0) return [];
  return findWaterPathThroughPoints([from, ...waypoints, to], map);
}

function findWaterPathThroughPoints(points: Array<{ x: number; y: number }>, map: PharosVilleMap): Array<{ x: number; y: number }> {
  const route: Array<{ x: number; y: number }> = [];
  for (let index = 1; index < points.length; index += 1) {
    const leg = findWaterPath(points[index - 1]!, points[index]!, map);
    if (leg.length === 0) return [];
    route.push(...(route.length === 0 ? leg : leg.slice(1)));
  }
  return route;
}

function detourWaterWaypoints(from: { x: number; y: number }, to: { x: number; y: number }, map: PharosVilleMap): Array<{ x: number; y: number }> {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 8) return [];

  const seed = stableHash(`${from.x}.${from.y}->${to.x}.${to.y}.wander`);
  const waypointCount = distance > 24 ? 2 : 1;
  const primarySign = seed % 2 === 0 ? 1 : -1;
  const perpendicular = { x: -dy / distance, y: dx / distance };
  const waypoints: Array<{ x: number; y: number }> = [];

  for (let index = 0; index < waypointCount; index += 1) {
    const ratioBase = waypointCount === 1 ? 0.5 : (index + 1) / (waypointCount + 1);
    const ratio = clamp(ratioBase + stableOffset(`${seed}.${index}.ratio`, 4) * 0.018, 0.2, 0.8);
    const sign = waypointCount === 1 ? primarySign : primarySign * (index % 2 === 0 ? 1 : -1);
    const detour = clamp(distance * (0.18 + (stableUnit(`${seed}.${index}.detour`) * 0.12)), 3, 9);
    const candidate = nearestMapWaterTile({
      x: from.x + dx * ratio + perpendicular.x * detour * sign,
      y: from.y + dy * ratio + perpendicular.y * detour * sign,
    }, map);

    if (sameTile(candidate, from) || sameTile(candidate, to)) continue;
    if (waypoints.some((waypoint) => sameTile(waypoint, candidate))) continue;
    waypoints.push(candidate);
  }

  return waypoints;
}

function findWaterPath(from: { x: number; y: number }, to: { x: number; y: number }, map: PharosVilleMap): Array<{ x: number; y: number }> {
  const startIndex = tileIndex(from.x, from.y, map);
  const endIndex = tileIndex(to.x, to.y, map);
  if (startIndex < 0 || endIndex < 0) return [];

  const distances = new Array(map.width * map.height).fill(Number.POSITIVE_INFINITY);
  const previous = new Array<number>(map.width * map.height).fill(-1);
  const open = [startIndex];
  distances[startIndex] = 0;

  while (open.length > 0) {
    let bestOpenIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < open.length; index += 1) {
      const currentIndex = open[index]!;
      const current = indexToTile(currentIndex, map);
      const score = distances[currentIndex]! + Math.abs(current.x - to.x) + Math.abs(current.y - to.y);
      if (score < bestScore) {
        bestScore = score;
        bestOpenIndex = index;
      }
    }

    const [currentIndex] = open.splice(bestOpenIndex, 1);
    if (currentIndex === endIndex) return reconstructPath(previous, endIndex, map);

    const current = indexToTile(currentIndex!, map);
    for (const neighbor of waterNeighbors(current, map)) {
      const neighborIndex = tileIndex(neighbor.x, neighbor.y, map);
      const tile = map.tiles[neighborIndex];
      const cost = tile?.kind === "deep-water" ? 1.18 : 1;
      const nextDistance = distances[currentIndex!]! + cost;
      if (nextDistance >= distances[neighborIndex]!) continue;
      previous[neighborIndex] = currentIndex!;
      distances[neighborIndex] = nextDistance;
      if (!open.includes(neighborIndex)) open.push(neighborIndex);
    }
  }

  return [];
}

function reconstructPath(previous: readonly number[], endIndex: number, map: PharosVilleMap): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  let current = endIndex;
  while (current >= 0) {
    points.push(indexToTile(current, map));
    current = previous[current] ?? -1;
  }
  return points.reverse();
}

function waterNeighbors(tile: { x: number; y: number }, map: PharosVilleMap): Array<{ x: number; y: number }> {
  return [
    { x: tile.x + 1, y: tile.y },
    { x: tile.x, y: tile.y + 1 },
    { x: tile.x - 1, y: tile.y },
    { x: tile.x, y: tile.y - 1 },
  ].filter((candidate) => isWaterTile(candidate.x, candidate.y, map));
}

function nearestMapWaterTile(tile: { x: number; y: number }, map: PharosVilleMap): { x: number; y: number } {
  const rounded = {
    x: clamp(Math.round(tile.x), 0, map.width - 1),
    y: clamp(Math.round(tile.y), 0, map.height - 1),
  };
  if (isWaterTile(rounded.x, rounded.y, map)) return rounded;

  let bestTile: { x: number; y: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of map.tiles) {
    if (!WATER_KINDS.has(candidate.kind)) continue;
    const distance = Math.abs(candidate.x - rounded.x) + Math.abs(candidate.y - rounded.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestTile = { x: candidate.x, y: candidate.y };
    }
  }
  return bestTile ?? rounded;
}

function fallbackWaterWaypoint(from: { x: number; y: number }, to: { x: number; y: number }, map: PharosVilleMap): { x: number; y: number } {
  const seed = stableHash(`${from.x}.${from.y}->${to.x}.${to.y}`);
  const edgeTiles = map.tiles
    .filter((tile) => WATER_KINDS.has(tile.kind) && (tile.x === 0 || tile.y === 0 || tile.x === map.width - 1 || tile.y === map.height - 1))
    .sort((a, b) => {
      const aScore = Math.abs(a.x - from.x) + Math.abs(a.y - from.y) + Math.abs(a.x - to.x) + Math.abs(a.y - to.y);
      const bScore = Math.abs(b.x - from.x) + Math.abs(b.y - from.y) + Math.abs(b.x - to.x) + Math.abs(b.y - to.y);
      return aScore - bScore || ((a.x * 131 + a.y + seed) % 17) - ((b.x * 131 + b.y + seed) % 17);
    });
  const waypoint = edgeTiles[0] ?? map.tiles.find((tile) => WATER_KINDS.has(tile.kind));
  return waypoint ? { x: waypoint.x, y: waypoint.y } : from;
}

function waterPathFromPoints(from: { x: number; y: number }, to: { x: number; y: number }, points: Array<{ x: number; y: number }>): ShipWaterPath {
  const cumulativeLengths = [0];
  let totalLength = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    totalLength += Math.hypot(current.x - previous.x, current.y - previous.y);
    cumulativeLengths.push(totalLength);
  }
  return {
    from,
    to,
    points,
    cumulativeLengths,
    totalLength,
  };
}

function reverseWaterPath(path: ShipWaterPath): ShipWaterPath {
  return waterPathFromPoints(path.to, path.from, [...path.points].reverse());
}

function transitSample(input: {
  route: ShipMotionRoute;
  path: ShipWaterPath | undefined;
  progress: number;
  state: Extract<ShipMotionState, "arriving" | "departing" | "sailing">;
  dockId: string;
}): ShipMotionSample {
  const { point, heading } = sampleShipWaterPath(input.path, input.progress);
  return {
    shipId: input.route.shipId,
    tile: point,
    state: input.state,
    zone: input.route.zone,
    currentDockId: input.dockId,
    heading,
    wakeIntensity: input.route.zone === "storm" ? 0.7 : input.route.zone === "muddy" ? 0.5 : 0.35,
  };
}

function riskDriftSample(route: ShipMotionRoute, timeSeconds: number, progress: number): ShipMotionSample {
  const angle = timeSeconds * 0.12 + route.routeSeed * 0.0001 + progress * Math.PI * 2;
  return {
    shipId: route.shipId,
    tile: {
      x: route.riskTile.x + Math.cos(angle) * 0.12,
      y: route.riskTile.y + Math.sin(angle * 0.8) * 0.09,
    },
    state: "risk-drift",
    zone: route.zone,
    currentDockId: null,
    heading: normalizeHeading({ x: -Math.sin(angle), y: Math.cos(angle * 0.8) }),
    wakeIntensity: 0.08,
  };
}

export function sampleShipWaterPath(path: ShipWaterPath | undefined, progress: number): { point: { x: number; y: number }; heading: { x: number; y: number } } {
  if (!path || path.points.length === 0) return { point: { x: 0, y: 0 }, heading: { x: 0, y: 0 } };
  if (path.points.length === 1 || path.totalLength <= 0) return { point: path.points[0]!, heading: { x: 0, y: 0 } };

  const distance = clamp(progress, 0, 1) * path.totalLength;
  for (let index = 1; index < path.points.length; index += 1) {
    const segmentEnd = path.cumulativeLengths[index]!;
    if (distance > segmentEnd) continue;
    const segmentStart = path.cumulativeLengths[index - 1]!;
    const previous = path.points[index - 1]!;
    const current = path.points[index]!;
    const segmentProgress = segmentEnd === segmentStart ? 0 : (distance - segmentStart) / (segmentEnd - segmentStart);
    return {
      point: {
        x: previous.x + (current.x - previous.x) * segmentProgress,
        y: previous.y + (current.y - previous.y) * segmentProgress,
      },
      heading: normalizeHeading({ x: current.x - previous.x, y: current.y - previous.y }),
    };
  }

  const last = path.points[path.points.length - 1]!;
  const previous = path.points[path.points.length - 2] ?? last;
  return {
    point: last,
    heading: normalizeHeading({ x: last.x - previous.x, y: last.y - previous.y }),
  };
}

function isWaterTile(x: number, y: number, map: PharosVilleMap): boolean {
  const index = tileIndex(x, y, map);
  if (index < 0) return false;
  const kind = map.tiles[index]?.kind;
  return !!kind && WATER_KINDS.has(kind);
}

function tileIndex(x: number, y: number, map: PharosVilleMap): number {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return -1;
  return y * map.width + x;
}

function indexToTile(index: number, map: PharosVilleMap): { x: number; y: number } {
  return {
    x: index % map.width,
    y: Math.floor(index / map.width),
  };
}

function sameTile(a: { x: number; y: number }, b: { x: number; y: number }) {
  return a.x === b.x && a.y === b.y;
}

function pathKey(from: { x: number; y: number }, to: { x: number; y: number }) {
  return `${from.x}.${from.y}->${to.x}.${to.y}`;
}

function stableHash(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function stableUnit(id: string) {
  return stableHash(id) / 0xffffffff;
}

function stableOffset(id: string, span: number): number {
  return (stableHash(id) % (span * 2 + 1)) - span;
}

function smoothstep(value: number) {
  const clamped = clamp(value, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function normalizeHeading(vector: { x: number; y: number }): { x: number; y: number } {
  const magnitude = Math.hypot(vector.x, vector.y);
  if (magnitude <= 0) return { x: 0, y: 0 };
  return { x: vector.x / magnitude, y: vector.y / magnitude };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
