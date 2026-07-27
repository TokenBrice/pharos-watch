import { useEffect, useRef, useState } from "react";
import {
  validateSelectorSnapshotResponse,
  type SelectorInput,
  type SelectorOutput,
} from "@shared/lib/selector";
import {
  useBluechipRatings,
  useDexLiquidity,
  usePegSummary,
  useRedemptionBackstops,
  useReportCardsV9,
  useStressSignals,
  useYieldRankings,
} from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { isValidSelectorSnapshotId } from "./selector-state";
import { RequestFailure, RequestSequence, isRequestCancellation, requestJson } from "@/lib/request";

export type UseSelectorResult =
  | { status: "loading" }
  | { status: "ready"; output: SelectorOutput }
  | { status: "snapshot-loading" }
  | {
      status: "snapshot-found";
      output: SelectorOutput;
      isFrozen: true;
      liveOutput: SelectorOutput | null;
      liveStatus: "loading" | "ready" | "error";
    }
  | { status: "snapshot-miss"; output: SelectorOutput; bannerKey: "snapshot-miss" }
  | { status: "error"; reason: string };

type SnapshotFetchResult =
  { kind: "found"; output: SelectorOutput } | { kind: "missing" } | { kind: "error"; reason: string };

async function defaultFetchSnapshot(sid: string, signal: AbortSignal): Promise<SnapshotFetchResult> {
  if (!isValidSelectorSnapshotId(sid)) {
    return { kind: "error", reason: "invalid-snapshot-id" };
  }
  try {
    const payload = await requestJson<unknown>(`/selector-snapshot/${encodeURIComponent(sid)}`, {
      signal,
      init: {
        method: "GET",
        headers: { Accept: "application/json" },
      },
    });
    const snapshot = validateSelectorSnapshotResponse(payload);
    if (!snapshot.ok) {
      return { kind: "error", reason: "snapshot-corrupt" };
    }
    return { kind: "found", output: snapshot.snapshot };
  } catch (error) {
    if (isRequestCancellation(error)) throw error;
    if (error instanceof RequestFailure && error.kind === "http") {
      if (error.status === 404) return { kind: "missing" };
      if (error.status === 502) return { kind: "error", reason: "snapshot-corrupt" };
      if (error.status === 500 || error.status === 503) {
        return { kind: "error", reason: "snapshot-store-unavailable" };
      }
    }
    return {
      kind: "error",
      reason:
        typeof navigator !== "undefined" && navigator.onLine === false
          ? "offline"
          : error instanceof Error
            ? error.message
            : "snapshot-fetch-failed",
    };
  }
}

export function useSelector(input: SelectorInput | null, sid: string | null): UseSelectorResult {
  const stablecoins = useStablecoins();
  const pegSummary = usePegSummary();
  const reportCards = useReportCardsV9();
  const stressSignals = useStressSignals();
  const dexLiquidity = useDexLiquidity();
  const yieldRankings = useYieldRankings();
  const bluechipRatings = useBluechipRatings();
  const redemptionBackstops = useRedemptionBackstops();
  const snapshotRequests = useRef(new RequestSequence());

  const [snapshotState, setSnapshotState] = useState<
    | { kind: "idle" }
    | { kind: "loading"; sid: string }
    | { kind: "found"; sid: string; output: SelectorOutput }
    | { kind: "miss"; sid: string }
    | { kind: "error"; sid: string; reason: string }
  >(sid ? { kind: "loading", sid } : { kind: "idle" });

  useEffect(() => {
    const requests = snapshotRequests.current;
    if (!sid) {
      requests.cancel();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- snapshot state follows the URL snapshot identity
      setSnapshotState({ kind: "idle" });
      return;
    }
    setSnapshotState({ kind: "loading", sid });
    void requests
      .run((signal) => defaultFetchSnapshot(sid, signal))
      .then((result) => {
        if (result.kind === "found") {
          setSnapshotState({ kind: "found", sid, output: result.output });
        } else if (result.kind === "missing") {
          setSnapshotState({ kind: "miss", sid });
        } else {
          setSnapshotState({ kind: "error", sid, reason: result.reason });
        }
      })
      .catch((error) => {
        if (!isRequestCancellation(error)) {
          setSnapshotState({ kind: "error", sid, reason: "snapshot-fetch-failed" });
        }
      });
    return () => {
      requests.cancel();
    };
  }, [sid]);

  const liveInput = input ?? (snapshotState.kind === "found" ? snapshotState.output.input : null);
  const criticalQueryFailed =
    (stablecoins.error != null && stablecoins.data === undefined) ||
    (reportCards.error != null && reportCards.data === undefined);

  const datasetReady =
    stablecoins.data?.peggedAssets != null &&
    reportCards.data?.cards != null &&
    queryDataOrErrorSettled(pegSummary) &&
    queryDataOrErrorSettled(stressSignals) &&
    queryDataOrErrorSettled(dexLiquidity) &&
    queryDataOrErrorSettled(bluechipRatings) &&
    queryDataOrErrorSettled(redemptionBackstops) &&
    (liveInput?.profile !== "yield" || queryDataOrErrorSettled(yieldRankings));

  if (sid) {
    if (snapshotState.kind === "loading") return { status: "snapshot-loading" };
    if (snapshotState.kind === "found") {
      return {
        status: "snapshot-found",
        output: snapshotState.output,
        isFrozen: true,
        liveOutput: null,
        liveStatus: criticalQueryFailed ? "error" : !datasetReady ? "loading" : "error",
      };
    }
    if (snapshotState.kind === "error") {
      return { status: "error", reason: snapshotState.reason };
    }
    if (snapshotState.kind === "miss") {
      if (!input) return { status: "error", reason: "snapshot-not-found" };
      if (criticalQueryFailed) return { status: "error", reason: "selector-data-unavailable" };
      if (!datasetReady) return { status: "snapshot-loading" };
      return { status: "error", reason: "v9-selector-thresholds-unreviewed" };
    }
  }

  if (!input) return { status: "loading" };
  if (criticalQueryFailed) return { status: "error", reason: "selector-data-unavailable" };
  if (!datasetReady) return { status: "loading" };
  return { status: "error", reason: "v9-selector-thresholds-unreviewed" };
}

function queryDataOrErrorSettled(query: { data?: unknown; error?: unknown }): boolean {
  return query.data !== undefined || query.error != null;
}
