import { makeSafetySnapshotCache, seedActiveSafetySource } from "./dispatch-telegram-alerts.test-support";
import type { DispatchHarness } from "./dispatch-telegram-alerts.test-support";

type SafetySnapshot = Record<string, { grade: string; score: number | null; methodologyVersion: string | null }>;

export interface DispatchSnapshotSeed {
  dews?: Record<string, string>;
  dewsAlertable?: Record<string, string>;
  depeg?: Record<string, unknown>;
  safety?: SafetySnapshot | string;
  safetySource?: SafetySnapshot;
  launch?: string[];
  reserve?: unknown;
  reserveDispatched?: string[];
  updatedAt?: number;
}

export function seedDispatchSnapshots(harness: DispatchHarness, options: DispatchSnapshotSeed = {}): void {
  const at = options.updatedAt ?? Math.floor(Date.now() / 1000) - 60;
  harness.cache("alert:dews-snapshot", options.dews ?? {}, at);
  harness.cache("alert:depeg-snapshot", options.depeg ?? {}, at);
  harness.cache("alert:safety-snapshot", typeof options.safety === "string"
    ? options.safety : makeSafetySnapshotCache(options.safety ?? {}).value, at);
  if (options.safetySource !== undefined) seedActiveSafetySource(harness, options.safetySource, at);
  if (options.dewsAlertable !== undefined) harness.cache("alert:dews-alertable-snapshot", options.dewsAlertable, at);
  if (options.launch !== undefined) harness.cache("alert:launch-snapshot", options.launch, at);
  if (options.reserve !== undefined) harness.cache("alert:reserve-snapshot", options.reserve, at);
  if (options.reserveDispatched !== undefined) harness.cache("alert:reserve-dispatched-snapshot", options.reserveDispatched, at);
}
