import { MAX_TILE_X, MAX_TILE_Y, isWaterTileKind, nearestWaterTile } from "./world-layout";
import { SHIP_WATER_ANCHORS } from "./risk-water-areas";
import { stableHash, stableOffset, stableUnit } from "./stable-random";
import type { PharosVilleMap, PharosVilleTile, PharosVilleWorld, ShipDockVisit, ShipNode, ShipWaterZone } from "./world-types";

export interface ShipWaterPath {
  from: { x: number; y: number };
  to: { x: number; y: number };
  points: Array<{ x: number; y: number }>;
  cumulativeLengths: number[];
  totalLength: number;
}

export type ShipMotionState = "idle" | "moored" | "departing" | "sailing" | "risk-drift" | "arriving";

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
  homeDockId: string | null;
  openWaterPatrol: {
    outbound: ShipWaterPath;
    inbound: ShipWaterPath;
    waypoint: { x: number; y: number };
  } | null;
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

export interface PharosVilleBaseMotionPlan {
  animatedShipIds: ReadonlySet<string>;
  baseEffectShipIds: ReadonlySet<string>;
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

const ZONE_DWELL: Record<ShipWaterZone, { dockDwell: number; riskDwell: number; transit: number }> = {
  alert: { riskDwell: 0.38, dockDwell: 0.18, transit: 0.44 },
  calm: { riskDwell: 0.24, dockDwell: 0.24, transit: 0.52 },
  danger: { riskDwell: 0.58, dockDwell: 0.06, transit: 0.36 },
  ledger: { riskDwell: 0.48, dockDwell: 0.1, transit: 0.42 },
  warning: { riskDwell: 0.46, dockDwell: 0.12, transit: 0.42 },
  watch: { riskDwell: 0.3, dockDwell: 0.22, transit: 0.48 },
};

const OPEN_WATER_PATROL_WAYPOINTS: Record<ShipWaterZone, readonly { x: number; y: number }[]> = {
  alert: [...SHIP_WATER_ANCHORS["harbor-mouth-watch"], ...SHIP_WATER_ANCHORS["outer-rough-water"], ...SHIP_WATER_ANCHORS["breakwater-edge"]],
  calm: SHIP_WATER_ANCHORS["safe-harbor"],
  danger: [...SHIP_WATER_ANCHORS["storm-shelf"], ...SHIP_WATER_ANCHORS["outer-rough-water"]],
  ledger: SHIP_WATER_ANCHORS["ledger-mooring"],
  warning: [...SHIP_WATER_ANCHORS["outer-rough-water"], ...SHIP_WATER_ANCHORS["storm-shelf"]],
  watch: [...SHIP_WATER_ANCHORS["breakwater-edge"], ...SHIP_WATER_ANCHORS["safe-harbor"]],
};

export function buildBaseMotionPlan(world: PharosVilleWorld): PharosVilleBaseMotionPlan {
  const topShips = world.ships
    .toSorted((a, b) => b.marketCapUsd - a.marketCapUsd)
    .slice(0, 48);
  const moverShips = world.ships
    .filter(hasRecentMove)
    .toSorted((a, b) => Math.abs(b.change24hUsd ?? 0) - Math.abs(a.change24hUsd ?? 0))
    .slice(0, 16);
  const baseEffectShipIds = new Set<string>();
  for (const ship of topShips) baseEffectShipIds.add(ship.id);
  for (const ship of moverShips) baseEffectShipIds.add(ship.id);

  return {
    animatedShipIds: new Set(world.ships.map((ship) => ship.id)),
    baseEffectShipIds,
    lighthouseFireFlickerPerSecond: lighthouseFireFlickerSpeed(world.lighthouse.psiBand, world.lighthouse.score),
    moverShipIds: new Set(moverShips.map((ship) => ship.id)),
    shipPhases: new Map(world.ships.map((ship) => [ship.id, stableMotionPhase(ship.id)])),
    shipRoutes: new Map(world.ships.map((ship) => [ship.id, buildShipMotionRoute(ship, world.map)])),
  };
}

export function buildMotionPlan(
  world: PharosVilleWorld,
  selectedDetailId: string | null,
  basePlan: PharosVilleBaseMotionPlan = buildBaseMotionPlan(world),
): PharosVilleMotionPlan {
  const effectShipIds = new Set(basePlan.baseEffectShipIds);
  const selectedShip = selectedDetailId
    ? world.ships.find((ship) => ship.detailId === selectedDetailId)
    : null;
  if (selectedShip) effectShipIds.add(selectedShip.id);

  return {
    animatedShipIds: basePlan.animatedShipIds,
    effectShipIds,
    lighthouseFireFlickerPerSecond: basePlan.lighthouseFireFlickerPerSecond,
    moverShipIds: basePlan.moverShipIds,
    shipPhases: basePlan.shipPhases,
    shipRoutes: basePlan.shipRoutes,
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
      tile: route?.riskTile ?? input.ship.riskTile,
      state: "idle",
      zone: input.ship.riskZone,
      currentDockId: null,
      heading: { x: 0, y: 0 },
      wakeIntensity: 0,
    };
  }

  const scheduledStopCount = Math.min(dockStopCount(route.dockStops.length), route.dockStopSchedule.length);
  if (scheduledStopCount === 0) {
    return openWaterPatrolSample(route, input.timeSeconds);
  }

  const cyclePosition = input.timeSeconds + route.phaseSeconds;
  const elapsedSeconds = positiveModulo(cyclePosition, route.cycleSeconds);
  const cycleIndex = Math.floor(cyclePosition / route.cycleSeconds);
  const stops = scheduledDockStopsForCycle(route, cycleIndex, scheduledStopCount);
  if (stops.length === 0) return openWaterPatrolSample(route, input.timeSeconds);

  const zoneDwell = ZONE_DWELL[route.zone];
  const riskSecondsEach = route.cycleSeconds * zoneDwell.riskDwell / stops.length;
  const dockSecondsEach = route.cycleSeconds * zoneDwell.dockDwell / stops.length;
  const transitSecondsEach = route.cycleSeconds * zoneDwell.transit / (stops.length * 2);
  let cursor = elapsedSeconds;

  for (let stopIndex = 0; stopIndex < stops.length; stopIndex += 1) {
    const stop = stops[stopIndex]!;
    const nextStop = stops[(stopIndex + 1) % stops.length]!;

    if (cursor < dockSecondsEach) {
      return mooredSample(route, stop, input.timeSeconds);
    }
    cursor -= dockSecondsEach;

    if (cursor < transitSecondsEach) {
      return transitSample({
        route,
        path: route.waterPaths.get(pathKey(stop.mooringTile, route.riskTile)),
        progress: smoothstep(cursor / Math.max(1, transitSecondsEach)),
        state: "departing",
        dockId: stop.dockId,
      });
    }
    cursor -= transitSecondsEach;

    if (cursor < riskSecondsEach) {
      return riskDriftSample(route, input.timeSeconds, cursor / Math.max(1, riskSecondsEach));
    }
    cursor -= riskSecondsEach;

    if (cursor < transitSecondsEach) {
      return transitSample({
        route,
        path: route.waterPaths.get(pathKey(route.riskTile, nextStop.mooringTile)),
        progress: smoothstep(cursor / Math.max(1, transitSecondsEach)),
        state: "arriving",
        dockId: nextStop.dockId,
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
  return (stableHash(id) % 628) / 100;
}

function hasRecentMove(ship: ShipNode) {
  const absolute = Math.abs(ship.change24hUsd ?? 0);
  const percentage = Math.abs(ship.change24hPct ?? 0);
  return absolute >= 1_000_000 || percentage >= 0.01;
}

function buildShipMotionRoute(ship: ShipNode, map: PharosVilleMap): ShipMotionRoute {
  const riskTile = nearestWaterTile(ship.riskTile);
  const dockStops = ship.dockVisits.map((visit) => ({ ...visit }));
  const cycleSeconds = shipCycleSeconds(ship);
  const waterPaths = new Map<string, ShipWaterPath>();
  const openWaterPatrol = dockStops.length === 0
    ? buildOpenWaterPatrol(ship, riskTile, map)
    : null;
  const homeDockId = primaryDockStop(ship, dockStops)?.dockId ?? null;

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
    homeDockId,
    openWaterPatrol,
    waterPaths,
    routeSeed: stableHash(ship.id),
  };
}

function primaryDockStop(ship: ShipNode, dockStops: readonly ShipMotionRoute["dockStops"][number][]) {
  return dockStops.find((stop) => stop.chainId === ship.homeDockChainId)
    ?? dockStops.toSorted((a, b) => b.weight - a.weight || a.dockId.localeCompare(b.dockId))[0]
    ?? null;
}

function shipCycleSeconds(ship: ShipNode): number {
  const positiveChainCount = ship.chainPresence.length;
  const renderedDockCount = ship.dockVisits.length;
  const base = 1260;
  const breadthBonus = Math.min(360, positiveChainCount * 30 + renderedDockCount * 24);
  const jitter = stableOffset(`${ship.id}.cycle`, 84);
  return clamp(base - breadthBonus + jitter, 780, 1560);
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

function scheduledDockStopsForCycle(
  route: ShipMotionRoute,
  cycleIndex: number,
  scheduledStopCount: number,
): Array<ShipMotionRoute["dockStops"][number]> {
  const scheduledStops: Array<ShipMotionRoute["dockStops"][number]> = [];
  const homeStop = route.homeDockId
    ? route.dockStops.find((stop) => stop.dockId === route.homeDockId) ?? null
    : null;
  if (homeStop && scheduledStopCount > 0) scheduledStops.push(homeStop);

  const slots = scheduledStopCount - scheduledStops.length;
  const scheduledNonHomeIds = route.dockStopSchedule
    .filter((dockId, index, dockIds) => dockId !== homeStop?.dockId && dockIds.indexOf(dockId) === index);
  const fallbackNonHomeIds = route.dockStops
    .map((stop) => stop.dockId)
    .filter((dockId) => dockId !== homeStop?.dockId);
  const nonHomeIds = scheduledNonHomeIds.length > 0 ? scheduledNonHomeIds : fallbackNonHomeIds;
  const offset = nonHomeIds.length > 0 ? positiveModulo(cycleIndex * Math.max(1, slots), nonHomeIds.length) : 0;

  for (let index = 0; index < nonHomeIds.length && scheduledStops.length < scheduledStopCount; index += 1) {
    const dockId = nonHomeIds[positiveModulo(offset + index, nonHomeIds.length)]!;
    const stop = route.dockStops.find((entry) => entry.dockId === dockId) ?? null;
    if (!stop || scheduledStops.some((entry) => entry.dockId === stop.dockId)) continue;
    scheduledStops.push(stop);
  }

  return scheduledStops.slice(0, scheduledStopCount);
}

function dockStopCount(renderedDockCount: number) {
  if (renderedDockCount <= 0) return 0;
  if (renderedDockCount === 1) return 1;
  if (renderedDockCount <= 3) return 2;
  return 3;
}

function buildOpenWaterPatrol(
  ship: ShipNode,
  riskTile: { x: number; y: number },
  map: PharosVilleMap,
): ShipMotionRoute["openWaterPatrol"] {
  const waypoint = openWaterPatrolWaypoint(ship, riskTile, map);
  const outbound = buildShipWaterRoute({ from: riskTile, to: waypoint, map });
  if (outbound.points.length <= 1 || outbound.totalLength <= 0) return null;
  return {
    waypoint,
    outbound,
    inbound: reverseWaterPath(outbound),
  };
}

function openWaterPatrolWaypoint(
  ship: ShipNode,
  riskTile: { x: number; y: number },
  map: PharosVilleMap,
): { x: number; y: number } {
  const waypoints = OPEN_WATER_PATROL_WAYPOINTS[ship.riskZone];
  const offset = stableHash(`${ship.id}.open-water-patrol`) % waypoints.length;
  let fallback = nearestMapWaterTile(waypoints[offset] ?? riskTile, map);
  let fallbackDistance = Math.hypot(fallback.x - riskTile.x, fallback.y - riskTile.y);

  for (let index = 0; index < waypoints.length; index += 1) {
    const candidate = nearestMapWaterTile(waypoints[(offset + index) % waypoints.length]!, map);
    const distance = Math.hypot(candidate.x - riskTile.x, candidate.y - riskTile.y);
    if (distance > fallbackDistance) {
      fallback = candidate;
      fallbackDistance = distance;
    }
    if (distance >= 8) return candidate;
  }

  return fallback;
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
    if (!isMotionWaterTile(candidate)) continue;
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
    .filter((tile) => isMotionWaterTile(tile) && (tile.x === 0 || tile.y === 0 || tile.x === map.width - 1 || tile.y === map.height - 1))
    .sort((a, b) => {
      const aScore = Math.abs(a.x - from.x) + Math.abs(a.y - from.y) + Math.abs(a.x - to.x) + Math.abs(a.y - to.y);
      const bScore = Math.abs(b.x - from.x) + Math.abs(b.y - from.y) + Math.abs(b.x - to.x) + Math.abs(b.y - to.y);
      return aScore - bScore || ((a.x * 131 + a.y + seed) % 17) - ((b.x * 131 + b.y + seed) % 17);
    });
  const waypoint = edgeTiles[0] ?? map.tiles.find((tile) => isMotionWaterTile(tile));
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
  dockId: string | null;
}): ShipMotionSample {
  const { point, heading } = sampleShipWaterPath(input.path, input.progress);
  return {
    shipId: input.route.shipId,
    tile: point,
    state: input.state,
    zone: input.route.zone,
    currentDockId: input.dockId,
    heading,
    wakeIntensity: transitWakeIntensityForZone(input.route.zone),
  };
}

function openWaterPatrolSample(route: ShipMotionRoute, timeSeconds: number): ShipMotionSample {
  if (!route.openWaterPatrol) return riskDriftSample(route, timeSeconds, 0.18);

  const cyclePosition = timeSeconds + route.phaseSeconds;
  const elapsedSeconds = positiveModulo(cyclePosition, route.cycleSeconds);
  const zoneDwell = ZONE_DWELL[route.zone];
  const riskSeconds = route.cycleSeconds * zoneDwell.riskDwell;
  const waypointSeconds = route.cycleSeconds * zoneDwell.dockDwell;
  const transitSecondsEach = (route.cycleSeconds - riskSeconds - waypointSeconds) / 2;
  let cursor = elapsedSeconds;

  if (cursor < riskSeconds) {
    return riskDriftSample(route, timeSeconds, cursor / Math.max(1, riskSeconds));
  }
  cursor -= riskSeconds;

  if (cursor < transitSecondsEach) {
    return transitSample({
      route,
      path: route.openWaterPatrol.outbound,
      progress: smoothstep(cursor / Math.max(1, transitSecondsEach)),
      state: "sailing",
      dockId: null,
    });
  }
  cursor -= transitSecondsEach;

  if (cursor < waypointSeconds) {
    return openWaterWaypointDriftSample(route, timeSeconds, cursor / Math.max(1, waypointSeconds));
  }
  cursor -= waypointSeconds;

  return transitSample({
    route,
    path: route.openWaterPatrol.inbound,
    progress: smoothstep(cursor / Math.max(1, transitSecondsEach)),
    state: "sailing",
    dockId: null,
  });
}

function openWaterWaypointDriftSample(route: ShipMotionRoute, timeSeconds: number, progress: number): ShipMotionSample {
  if (!route.openWaterPatrol) return riskDriftSample(route, timeSeconds, progress);
  const angle = timeSeconds * 0.023 + route.routeSeed * 0.00013 + progress * Math.PI * 2;
  return {
    shipId: route.shipId,
    tile: {
      x: route.openWaterPatrol.waypoint.x + Math.cos(angle) * 0.32,
      y: route.openWaterPatrol.waypoint.y + Math.sin(angle * 0.85) * 0.22,
    },
    state: "sailing",
    zone: route.zone,
    currentDockId: null,
    heading: normalizeHeading({ x: -Math.sin(angle), y: Math.cos(angle * 0.85) }),
    wakeIntensity: patrolWakeIntensityForZone(route.zone),
  };
}

function mooredSample(
  route: ShipMotionRoute,
  stop: ShipMotionRoute["dockStops"][number],
  timeSeconds: number,
): ShipMotionSample {
  const seed = stableHash(`${route.shipId}.${stop.dockId}.moored`);
  const angle = timeSeconds * 0.027 + seed * 0.0001;
  const radius = mooredRadiusForZone(route.zone);
  return {
    shipId: route.shipId,
    tile: {
      x: stop.mooringTile.x + Math.cos(angle) * radius.x,
      y: stop.mooringTile.y + Math.sin(angle * 0.9) * radius.y,
    },
    state: "moored",
    zone: route.zone,
    currentDockId: stop.dockId,
    heading: normalizeHeading({ x: -Math.sin(angle), y: Math.cos(angle * 0.9) }),
    wakeIntensity: 0.05,
  };
}

function mooredRadiusForZone(zone: ShipWaterZone): { x: number; y: number } {
  if (zone === "danger") return { x: 0.22, y: 0.14 };
  if (zone === "warning") return { x: 0.24, y: 0.16 };
  if (zone === "alert") return { x: 0.26, y: 0.17 };
  return { x: 0.28, y: 0.18 };
}

function riskDriftSample(route: ShipMotionRoute, timeSeconds: number, progress: number): ShipMotionSample {
  const angle = timeSeconds * 0.017 + route.routeSeed * 0.0001 + progress * Math.PI * 2;
  const radius = driftRadiusForZone(route.zone);
  const tile = clampMotionTile({
    x: route.riskTile.x + Math.cos(angle) * radius.x,
    y: route.riskTile.y + Math.sin(angle * 0.8) * radius.y,
  });
  return {
    shipId: route.shipId,
    tile,
    state: "risk-drift",
    zone: route.zone,
    currentDockId: null,
    heading: normalizeHeading({ x: -Math.sin(angle), y: Math.cos(angle * 0.8) }),
    wakeIntensity: 0.08,
  };
}

function clampMotionTile(tile: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(MAX_TILE_X, tile.x)),
    y: Math.max(0, Math.min(MAX_TILE_Y, tile.y)),
  };
}

function driftRadiusForZone(zone: ShipWaterZone): { x: number; y: number } {
  if (zone === "danger") return { x: 0.54, y: 0.36 };
  if (zone === "warning") return { x: 0.48, y: 0.32 };
  if (zone === "alert") return { x: 0.44, y: 0.3 };
  if (zone === "watch") return { x: 0.4, y: 0.28 };
  return { x: 0.38, y: 0.26 };
}

function transitWakeIntensityForZone(zone: ShipWaterZone): number {
  if (zone === "danger") return 0.72;
  if (zone === "warning") return 0.58;
  if (zone === "alert") return 0.5;
  if (zone === "watch") return 0.42;
  if (zone === "ledger") return 0.34;
  return 0.35;
}

function patrolWakeIntensityForZone(zone: ShipWaterZone): number {
  if (zone === "danger") return 0.66;
  if (zone === "warning") return 0.54;
  if (zone === "alert") return 0.48;
  if (zone === "watch") return 0.38;
  if (zone === "ledger") return 0.3;
  return 0.28;
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

export function shipWaterPathKey(from: { x: number; y: number }, to: { x: number; y: number }) {
  return pathKey(from, to);
}

function isWaterTile(x: number, y: number, map: PharosVilleMap): boolean {
  const index = tileIndex(x, y, map);
  if (index < 0) return false;
  const tile = map.tiles[index];
  return !!tile && isMotionWaterTile(tile);
}

function isMotionWaterTile(tile: Pick<PharosVilleTile, "kind" | "terrain">): boolean {
  return isWaterTileKind(tile.terrain ?? tile.kind);
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
