import {
  DexExitRouteObservationSchema,
  RedemptionExitRouteObservationSchema,
  type ExitRouteObservation,
  type ExitRouteOutput,
} from "../../types/exit-route";
import { stableJsonStringifyV1 } from "../stable-json";

export type ExitObservationLane = "dex" | "redemption";

export interface ExitObservationLaneSummary {
  assetCount: number;
  observationCount: number;
  resolvedAssetOutputCount: number;
  resolvedBasketOutputCount: number;
  unresolvedAssetOutputCount: number;
  unresolvedBasketOutputCount: number;
  unknownOutputCount: number;
}

export interface ExitObservationSetSummary {
  dex: ExitObservationLaneSummary;
  redemption: ExitObservationLaneSummary;
}

export interface MergedExitObservationSet {
  observationsByAssetId: ReadonlyMap<string, readonly ExitRouteObservation[]>;
  summary: ExitObservationSetSummary;
}

interface IndexedObservation {
  canonical: string;
  observation: ExitRouteObservation;
  origin: string;
}

type OutputDisposition = "resolved-asset" | "resolved-basket" | "unresolved-asset" | "unresolved-basket" | "unknown";

const EMPTY_LANE_SUMMARY: ExitObservationLaneSummary = {
  assetCount: 0,
  observationCount: 0,
  resolvedAssetOutputCount: 0,
  resolvedBasketOutputCount: 0,
  unresolvedAssetOutputCount: 0,
  unresolvedBasketOutputCount: 0,
  unknownOutputCount: 0,
};

function compareStableIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function outputDisposition(output: ExitRouteOutput): OutputDisposition {
  if (output.kind === "unresolved-asset") return "unresolved-asset";
  if (output.kind === "unresolved-basket") return "unresolved-basket";
  if (output.kind === "unknown") return "unknown";
  if (output.kind === "fiat") return output.currency ? "resolved-asset" : "unknown";

  const trackedAssetCount = output.trackedAssetIds?.length ?? 0;
  const assetKeyCount = output.assetKeys?.length ?? 0;
  const basketMemberCount = output.basketWeights?.length ?? 0;
  const resolvedIdentityCount = Math.max(trackedAssetCount, assetKeyCount, basketMemberCount);
  if (resolvedIdentityCount > 1) return "resolved-basket";
  return resolvedIdentityCount === 1 ? "resolved-asset" : "unknown";
}

function observationLabel(observation: ExitRouteObservation, index: number, lane: ExitObservationLane): string {
  return `${lane}[${index}] routeId "${observation.routeId}"`;
}

function validateLaneObservation(
  observation: ExitRouteObservation,
  index: number,
  lane: ExitObservationLane,
  assetId?: string,
): void {
  const schema = lane === "dex" ? DexExitRouteObservationSchema : RedemptionExitRouteObservationSchema;
  const result = schema.safeParse(observation);
  if (result.success) return;

  const location = assetId ? ` for asset "${assetId}"` : "";
  const issues = result.error.issues
    .map((issue) => `${issue.path.join(".") || "observation"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid ${observationLabel(observation, index, lane)}${location}: ${issues}`);
}

function addObservation(
  observationsByRouteId: Map<string, IndexedObservation>,
  observation: ExitRouteObservation,
  origin: string,
): void {
  const canonical = stableJsonStringifyV1(observation);
  const existing = observationsByRouteId.get(observation.routeId);
  if (!existing) {
    observationsByRouteId.set(observation.routeId, { canonical, observation, origin });
    return;
  }
  if (existing.canonical === canonical) return;

  throw new Error(
    `Conflicting exit-route observations for routeId "${observation.routeId}": ${existing.origin} differs from ${origin}`,
  );
}

/** Merge the two producer lanes for one asset using routeId as the stable identity. */
export function mergeExitRouteObservations(
  dexObservations: readonly ExitRouteObservation[],
  redemptionObservations: readonly ExitRouteObservation[],
  assetId?: string,
): readonly ExitRouteObservation[] {
  const observationsByRouteId = new Map<string, IndexedObservation>();
  const lanes = [
    ["dex", dexObservations],
    ["redemption", redemptionObservations],
  ] as const satisfies readonly (readonly [ExitObservationLane, readonly ExitRouteObservation[]])[];

  for (const [lane, observations] of lanes) {
    for (const [index, observation] of observations.entries()) {
      validateLaneObservation(observation, index, lane, assetId);
      const assetLabel = assetId ? `asset "${assetId}" ` : "";
      addObservation(observationsByRouteId, observation, `${assetLabel}${observationLabel(observation, index, lane)}`);
    }
  }

  return [...observationsByRouteId.values()]
    .sort((left, right) => compareStableIds(left.observation.routeId, right.observation.routeId))
    .map(({ observation }) => observation);
}

function summarizeLane(
  observationsByAssetId: ReadonlyMap<string, readonly ExitRouteObservation[]>,
  lane: ExitObservationLane,
): ExitObservationLaneSummary {
  const summary = { ...EMPTY_LANE_SUMMARY };
  for (const assetId of [...observationsByAssetId.keys()].sort(compareStableIds)) {
    const observations = observationsByAssetId.get(assetId) ?? [];
    const deduped =
      lane === "dex"
        ? mergeExitRouteObservations(observations, [], assetId)
        : mergeExitRouteObservations([], observations, assetId);
    if (deduped.length === 0) continue;

    summary.assetCount += 1;
    summary.observationCount += deduped.length;
    for (const observation of deduped) {
      const disposition = outputDisposition(observation.output);
      if (disposition === "resolved-asset") summary.resolvedAssetOutputCount += 1;
      else if (disposition === "resolved-basket") summary.resolvedBasketOutputCount += 1;
      else if (disposition === "unresolved-asset") summary.unresolvedAssetOutputCount += 1;
      else if (disposition === "unresolved-basket") summary.unresolvedBasketOutputCount += 1;
      else summary.unknownOutputCount += 1;
    }
  }
  return summary;
}

/** Merge per-asset producer maps and retain source-lane coverage diagnostics. */
export function mergeExitRouteObservationSets(
  dexObservationsByAssetId: ReadonlyMap<string, readonly ExitRouteObservation[]>,
  redemptionObservationsByAssetId: ReadonlyMap<string, readonly ExitRouteObservation[]>,
): MergedExitObservationSet {
  const assetIds = new Set([...dexObservationsByAssetId.keys(), ...redemptionObservationsByAssetId.keys()]);
  const observationsByAssetId = new Map<string, readonly ExitRouteObservation[]>();

  for (const assetId of [...assetIds].sort(compareStableIds)) {
    const observations = mergeExitRouteObservations(
      dexObservationsByAssetId.get(assetId) ?? [],
      redemptionObservationsByAssetId.get(assetId) ?? [],
      assetId,
    );
    if (observations.length > 0) observationsByAssetId.set(assetId, observations);
  }

  return {
    observationsByAssetId,
    summary: {
      dex: summarizeLane(dexObservationsByAssetId, "dex"),
      redemption: summarizeLane(redemptionObservationsByAssetId, "redemption"),
    },
  };
}
